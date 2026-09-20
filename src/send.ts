import { XMLParser } from "fast-xml-parser";

export interface Env {
  DB: D1Database;
  FEED_URL: string;
  PUBLIC_URL: string;
  SITE_NAME: string;
  SITE_URL: string;
  FROM: string;
  ADMIN_EMAIL: string;
  MAILGUN_DOMAIN: string;
  MAILGUN_API_KEY: string;
  MAILGUN_API_BASE?: string;
  TURNSTILE_SECRET: string;
  BATCH_SIZE?: string | number; // recipients per provider call; see batchSize()
}

export const STALE_MS = 7 * 24 * 60 * 60 * 1000;
// A batch still in flight after this is presumed dead mid-send and flagged.
export const FLAG_AFTER_MS = 15 * 60 * 1000;
// One recipient per call by default: providers commonly refuse batch sends from a new domain,
// and the refusal is easy to miss. Raise BATCH_SIZE (up to 1000, the provider's per-call limit)
// to send in batches again — worth it only once the domain is known to be allowed to.
export const DEFAULT_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 1000;
// Sending is sequential, so a long list can outrun the cron wall-clock limit. A tick stops when
// the budget is gone and the next one resumes from the cursor; without this, every row still
// in flight when the Worker is killed would be flagged.
export const SEND_BUDGET_MS = 10 * 60 * 1000;
// A provider that is refusing everything would otherwise log once per recipient.
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Per-tick send budget and failure streak. Mutated as the tick proceeds. */
interface Run {
  deadline: number;
  consecutiveFailures: number;
}

/** Whether this tick should stop sending: out of time, or the provider is refusing everything. */
function spent(run: Run): boolean {
  return Date.now() > run.deadline || run.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

export function batchSize(env: Env): number {
  const n = Number(env.BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  return Number.isInteger(n) && n >= 1 && n <= MAX_BATCH_SIZE ? n : DEFAULT_BATCH_SIZE;
}

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  html: string;
  pubDate: number; // NaN when missing
}

type Issue = Omit<FeedItem, "pubDate">;

interface Recipient {
  id: number;
  email: string;
  token: string;
}

export function parseFeed(xml: string): FeedItem[] {
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  const text = (v: unknown): string =>
    v && typeof v === "object" ? String((v as Record<string, unknown>)["#text"] ?? "") : String(v ?? "");
  return [doc?.rss?.channel?.item ?? []].flat().map((i: Record<string, unknown>) => {
    const link = text(i.link);
    return {
      guid: text(i.guid) || link,
      title: text(i.title),
      link,
      html: text(i["content:encoded"]) || text(i.description),
      pubDate: Date.parse(text(i.pubDate)),
    };
  });
}

/**
 * One cron tick. Overlapping ticks never double-send an issue; they can duplicate an admin alert.
 * Each phase is isolated so one failure (say, a D1 hiccup on one issue) can't starve the rest;
 * failures are rethrown together at the end so the cron run still shows as failed.
 */
export async function tick(env: Env, now = Date.now(), deadline = Date.now() + SEND_BUDGET_MS): Promise<void> {
  const errors: unknown[] = [];
  // Shared across every issue in this tick, so a provider that is down is reported once, not once
  // per recipient, and the wall-clock budget covers the whole run rather than each issue.
  const run: Run = { deadline, consecutiveFailures: 0 };
  const attempt = (what: string, fn: () => Promise<void>) =>
    fn().catch((e) => {
      console.error("tick phase failed; continuing:", what, e); // what may hold a feed guid: keep it out of the format string
      errors.push(e);
    });

  await attempt("flagging", async () => {
    await env.DB.prepare("UPDATE batches SET status = 'flagged' WHERE status = 'in_flight' AND started_at < ?")
      .bind(now - FLAG_AFTER_MS)
      .run();
    await alertFlagged(env, now);
  });
  await attempt("feed ingest", () => ingestFeed(env, now));

  const { results } = await env.DB.prepare(
    `SELECT guid, title, link, html FROM items
     WHERE issued_at IS NOT NULL
       AND (done_at IS NULL OR guid IN (SELECT guid FROM batches WHERE status = 'failed'))
     ORDER BY pub_date, guid`,
  ).all<Issue>();
  for (const issue of results) {
    if (spent(run)) break;
    await attempt(`issue ${issue.guid}`, () => sendIssue(env, issue, now, run));
  }
  if (spent(run)) {
    console.error(
      `tick stopped early: ${run.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? `${run.consecutiveFailures} sends failed in a row` : "send budget spent"}; the next tick resumes`,
    );
  }

  if (errors.length) throw new AggregateError(errors, `${errors.length} tick phase(s) failed`);
}

async function ingestFeed(env: Env, now: number) {
  const res = await fetch(env.FEED_URL);
  if (!res.ok) throw new Error(`feed fetch: HTTP ${res.status}`);
  const parsed = parseFeed(await res.text());
  // Without a guid or link there's no key to dedupe on; all such items would collide on "".
  const items = parsed.filter((i) => i.guid);
  if (items.length < parsed.length) console.error(`skipped ${parsed.length - items.length} feed item(s) with no guid or link`);
  if (!items.length) return;

  // First run: everything already in the feed counts as sent.
  const seeding = !(await env.DB.prepare("SELECT 1 FROM items LIMIT 1").first());
  await env.DB.batch(
    items.map((i) => {
      // NaN pubDate isn't stale: an undated item is treated as new.
      const issue = !seeding && !(i.pubDate < now - STALE_MS);
      return env.DB.prepare(
        `INSERT INTO items (guid, pub_date, seen_at, issued_at, title, link, html)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(
        i.guid,
        Number.isNaN(i.pubDate) ? null : i.pubDate,
        now,
        issue ? now : null,
        issue ? i.title : null,
        issue ? i.link : null,
        issue ? i.html : null,
      );
    }),
  );
}

async function sendIssue(env: Env, issue: Issue, now: number, run: Run) {
  const db = env.DB;

  const failed = await db
    .prepare("SELECT id, after_id, last_id FROM batches WHERE guid = ? AND status = 'failed'")
    .bind(issue.guid)
    .all<{ id: number; after_id: number; last_id: number }>();
  for (const b of failed.results) {
    if (spent(run)) return;
    const claim = await db
      .prepare("UPDATE batches SET status = 'in_flight', started_at = ? WHERE id = ? AND status = 'failed'")
      .bind(now, b.id)
      .run();
    if (claim.meta.changes !== 1) continue; // another tick took it
    const { results } = await db
      .prepare("SELECT id, email, token FROM subscribers WHERE status = 'active' AND id > ? AND id <= ? ORDER BY id")
      .bind(b.after_id, b.last_id)
      .all<Recipient>();
    await deliver(env, issue, b.id, results, run);
  }

  for (;;) {
    if (spent(run)) return;
    const row = await db.prepare("SELECT cursor, done_at FROM items WHERE guid = ?").bind(issue.guid).first<{
      cursor: number;
      done_at: number | null;
    }>();
    if (!row) throw new Error(`item ${issue.guid} vanished mid-issue`); // items rows are never deleted
    if (row.done_at) return;
    const { results } = await db
      .prepare("SELECT id, email, token FROM subscribers WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?")
      .bind(row.cursor, batchSize(env))
      .all<Recipient>();
    if (!results.length) {
      // The cursor check keeps a concurrent tick's fresh claim from being closed over.
      await db
        .prepare("UPDATE items SET done_at = ? WHERE guid = ? AND cursor = ?")
        .bind(now, issue.guid, row.cursor)
        .run();
      return;
    }

    const lastId = results[results.length - 1].id;
    // Both statements no-op if a concurrent tick already claimed this range.
    const [ins] = await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO batches (guid, after_id, last_id, status, started_at) VALUES (?, ?, ?, 'in_flight', ?) RETURNING id",
        )
        .bind(issue.guid, row.cursor, lastId, now),
      db.prepare("UPDATE items SET cursor = ? WHERE guid = ? AND cursor = ?").bind(lastId, issue.guid, row.cursor),
    ]);
    const claimed = ins.results[0] as { id: number } | undefined;
    if (!claimed) return;
    await deliver(env, issue, claimed.id, results, run);
  }
}

/** Sends one claimed batch. Leaves it in_flight when the outcome is unknown. */
async function deliver(env: Env, issue: Issue, batchId: number, recipients: Recipient[], run: Run) {
  let status = "sent"; // an empty retry range (everyone unsubscribed) is trivially sent
  if (recipients.length) {
    let res: Response;
    try {
      res = await mailgun(env, batchForm(env, issue, batchId, recipients));
    } catch (e) {
      // The request may have reached Mailgun. Don't guess: stay in flight, get flagged.
      run.consecutiveFailures++;
      console.error(`batch ${batchId}: outcome unknown`, e);
      return;
    }
    if (!res.ok) {
      run.consecutiveFailures++;
      // Only the first few of a run are logged; see MAX_CONSECUTIVE_FAILURES.
      console.error(`batch ${batchId}: Mailgun HTTP ${res.status}, will retry: ${await res.text()}`);
      status = "failed";
    } else {
      run.consecutiveFailures = 0;
    }
  }
  await env.DB.prepare("UPDATE batches SET status = ? WHERE id = ? AND status = 'in_flight'")
    .bind(status, batchId)
    .run();
}

function batchForm(env: Env, issue: Issue, batchId: number, recipients: Recipient[]): FormData {
  // A single recipient gets its real token and no recipient-variables: that field is what marks a
  // message as a batch send, and the point of sending one at a time is to look like a plain message.
  const single = recipients.length === 1 ? recipients[0] : null;
  const unsubscribe = `${env.PUBLIC_URL}/unsubscribe?t=${single ? single.token : "%recipient.token%"}`;
  const form = new FormData();
  form.set("from", env.FROM);
  form.set("subject", issue.title);
  form.set("html", renderIssue(env, issue, unsubscribe));
  for (const r of recipients) form.append("to", r.email);
  if (!single) {
    form.set("recipient-variables", JSON.stringify(Object.fromEntries(recipients.map((r) => [r.email, { token: r.token }]))));
  }
  form.set("h:List-Unsubscribe", `<${unsubscribe}>`);
  form.set("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  form.set("v:batch", String(batchId)); // searchable in Mailgun logs when resolving a flagged batch
  return form;
}

export function mailgun(env: Env, form: FormData): Promise<Response> {
  const base = env.MAILGUN_API_BASE || "https://api.mailgun.net";
  return fetch(`${base}/v3/${env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
    body: form,
  });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderIssue(env: Env, issue: Issue, unsubscribe: string): string {
  // Email clients strip <style>; inline styles only. Light regardless of the site's theme.
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;font:16px/1.6 Georgia,serif">
<p style="font:13px sans-serif;color:#666"><a href="${esc(issue.link)}" style="color:#666">Read on the web</a></p>
<h1 style="font-size:28px;line-height:1.25;margin:0 0 24px">${esc(issue.title)}</h1>
${issue.html}
<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px">
<p style="font:13px sans-serif;color:#666">You're getting this because you subscribed to
<a href="${esc(env.SITE_URL)}" style="color:#666">${esc(env.SITE_NAME)}</a>.
<a href="${unsubscribe}" style="color:#666">Unsubscribe</a>.</p>
</div></body></html>`;
}

async function alertFlagged(env: Env, now: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, guid, after_id, last_id, started_at FROM batches WHERE status = 'flagged' AND alerted_at IS NULL",
  ).all<{ id: number; guid: string; after_id: number; last_id: number; started_at: number }>();
  for (const b of results) {
    const sql = (status: string) =>
      `npx wrangler d1 execute DB --remote --command "UPDATE batches SET status = '${status}' WHERE id = ${b.id} AND status = 'flagged'"`;
    const form = new FormData();
    form.set("from", env.FROM);
    form.set("to", env.ADMIN_EMAIL);
    form.set("subject", `[${env.SITE_NAME}] Batch ${b.id} needs a decision`);
    form.set(
      "text",
      `Batch ${b.id} of ${b.guid} was handed to Mailgun at ${new Date(b.started_at).toISOString()} and never confirmed.
It may or may not have been delivered, so it will not be retried automatically.

Check Mailgun's logs for user variable batch=${b.id}. Recipients were active subscribers with ${b.after_id} < id <= ${b.last_id}.

If Mailgun accepted it:
  ${sql("sent")}

If it did not (the next tick resends it):
  ${sql("failed")}

Or run the resolve-flagged-batch skill in this repo with Claude Code.
`,
    );
    const res = await mailgun(env, form).catch((e) => (console.error("alert send failed", e), null));
    if (res?.ok) {
      await env.DB.prepare("UPDATE batches SET alerted_at = ? WHERE id = ?").bind(now, b.id).run();
    } else {
      console.error(`batch ${b.id} flagged; alert not sent, will retry next tick`);
    }
  }
}
