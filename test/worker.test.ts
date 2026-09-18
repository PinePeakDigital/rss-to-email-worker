import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { FLAG_AFTER_MS, STALE_MS, tick } from "../src/send";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function feed(items: { guid: string; date: number }[]): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>${items
    .map(
      (i) =>
        `<item><title>Post ${i.guid}</title><link>https://example.com/${i.guid}</link><guid>https://example.com/${i.guid}</guid>` +
        `<pubDate>${new Date(i.date).toUTCString()}</pubDate><content:encoded><![CDATA[<p>Body of ${i.guid}</p>]]></content:encoded></item>`,
    )
    .join("")}</channel></rss>`;
}

let feedXml: string;
let calls: FormData[];
let mailgunReply: (form: FormData, n: number) => Response | Promise<Response>;

const issueCalls = () => calls.filter((f) => f.has("v:batch"));
const alertCalls = () => calls.filter((f) => f.get("to") === env.ADMIN_EMAIL);
const recipients = () => issueCalls().flatMap((f) => f.getAll("to") as string[]);

async function addSubscribers(n: number, prefix: string, status = "active") {
  await env.DB.prepare(
    `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
     INSERT INTO subscribers (email, token, status) SELECT ? || i || '@x.test', ? || i, ? FROM s`,
  )
    .bind(n, prefix, `tok-${prefix}`, status)
    .run();
}

/** Seeds with one old post, then publishes a new one. */
async function publishNewPost() {
  feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]);
  await tick(env, NOW);
  feedXml = feed([
    { guid: "old", date: NOW - 30 * DAY },
    { guid: "new", date: NOW - 60_000 },
  ]);
}

beforeEach(async () => {
  feedXml = feed([]);
  calls = [];
  mailgunReply = () => Response.json({ id: "x" });
  await env.DB.batch(["batches", "items", "subscribers"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === env.FEED_URL) return new Response(feedXml);
    if (url.endsWith("/messages")) {
      const form = init!.body as FormData;
      calls.push(form);
      return mailgunReply(form, calls.length);
    }
    if (url.includes("turnstile")) return Response.json({ success: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("tick", () => {
  it("marks everything in the feed seen on first run, without sending", async () => {
    await addSubscribers(3, "a");
    feedXml = feed([
      { guid: "1", date: NOW - DAY },
      { guid: "2", date: NOW - 2 * DAY },
    ]);
    await tick(env, NOW);
    await tick(env, NOW + 3600_000);
    expect(calls).toHaveLength(0);
  });

  it("sends a new item once, to active subscribers only", async () => {
    await addSubscribers(3, "a");
    await addSubscribers(1, "p", "pending");
    await addSubscribers(1, "u", "unsubscribed");
    await publishNewPost();
    await tick(env, NOW);
    await tick(env, NOW + 3600_000);

    expect(recipients().sort()).toEqual(["a1@x.test", "a2@x.test", "a3@x.test"]);
    const form = issueCalls()[0];
    expect(form.get("subject")).toBe("Post new");
    expect(form.get("html")).toContain("<p>Body of new</p>");
    expect(form.get("h:List-Unsubscribe")).toBe(`<${env.PUBLIC_URL}/unsubscribe?t=%recipient.token%>`);
    expect(form.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(JSON.parse(form.get("recipient-variables") as string)["a2@x.test"]).toEqual({ token: "tok-a2" });
  });

  it("never sends a stale item", async () => {
    await addSubscribers(3, "a");
    feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]);
    await tick(env, NOW);
    feedXml = feed([
      { guid: "old", date: NOW - 30 * DAY },
      { guid: "backfill", date: NOW - STALE_MS - 60_000 },
    ]);
    await tick(env, NOW);
    expect(calls).toHaveLength(0);
  });

  it("retries a batch Mailgun refused, without resending the others", async () => {
    await addSubscribers(2500, "a");
    await publishNewPost();
    mailgunReply = (_f, n) => (n === 2 ? new Response("boom", { status: 500 }) : Response.json({}));
    await tick(env, NOW);
    expect(issueCalls()).toHaveLength(3);

    await tick(env, NOW + 3600_000);
    expect(issueCalls()).toHaveLength(4);
    expect(issueCalls()[3].getAll("to")).toEqual(issueCalls()[1].getAll("to"));

    const delivered = recipients().filter((_, i) => i < 1000 || i >= 2000); // drop the refused batch
    expect(delivered).toHaveLength(2500);
    expect(new Set(delivered).size).toBe(2500);

    await tick(env, NOW + 7200_000);
    expect(issueCalls()).toHaveLength(4);
  });

  it("flags a batch with unknown outcome, alerts once, and never resends it on its own", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    mailgunReply = () => {
      throw new Error("connection reset");
    };
    await tick(env, NOW);
    mailgunReply = () => Response.json({});

    await tick(env, NOW + FLAG_AFTER_MS / 2); // could still be mid-send: leave it alone
    expect(alertCalls()).toHaveLength(0);

    await tick(env, NOW + FLAG_AFTER_MS + 1);
    await tick(env, NOW + 2 * FLAG_AFTER_MS);
    expect(issueCalls()).toHaveLength(1);
    expect(alertCalls()).toHaveLength(1);
    expect(alertCalls()[0].get("text")).toContain("SET status = 'failed' WHERE id =");

    // The alert's "not delivered" command, then the next tick resends.
    await env.DB.prepare("UPDATE batches SET status = 'failed' WHERE status = 'flagged'").run();
    await tick(env, NOW + 3 * FLAG_AFTER_MS);
    expect(issueCalls()).toHaveLength(2);
    expect(issueCalls()[1].getAll("to")).toEqual(["a1@x.test", "a2@x.test", "a3@x.test"]);
  });

  it("includes subscribers who confirm mid-issue and skips those who leave", async () => {
    await addSubscribers(1500, "a");
    await publishNewPost();
    mailgunReply = async (_f, n) => {
      if (n === 1) {
        // Runs while batch 1 is in flight; batch 2 hasn't been claimed.
        await env.DB.batch([
          env.DB.prepare("INSERT INTO subscribers (email, token, status) VALUES ('late@x.test', 'tok-late', 'active')"),
          env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'a1400@x.test'"),
        ]);
      }
      return Response.json({});
    };
    await tick(env, NOW);
    const all = recipients();
    expect(all).toContain("late@x.test");
    expect(all).not.toContain("a1400@x.test");
    expect(new Set(all).size).toBe(all.length);
  });

  it("doesn't send a finished issue to someone who subscribes later", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    await tick(env, NOW);
    await addSubscribers(1, "later");
    await tick(env, NOW + 3600_000);
    expect(recipients()).not.toContain("later1@x.test");
  });

  it("sends each recipient once when ticks overlap", async () => {
    await addSubscribers(2500, "a");
    await publishNewPost();
    await Promise.all([tick(env, NOW), tick(env, NOW), tick(env, NOW)]);
    expect(recipients()).toHaveLength(2500);
    expect(new Set(recipients()).size).toBe(2500);
  });
});

describe("subscription pages", () => {
  const post = (path: string, body: Record<string, string> = {}) =>
    worker.fetch(new Request(`${env.PUBLIC_URL}${path}`, { method: "POST", body: new URLSearchParams(body) }), env);
  const status = async (email: string) =>
    (await env.DB.prepare("SELECT status, consent_source FROM subscribers WHERE email = ?").bind(email).first()) ?? {};

  it("runs subscribe → confirm → unsubscribe → resubscribe", async () => {
    const form = { email: " Reader@Example.com ", "cf-turnstile-response": "ok" };
    expect((await post("/subscribe", form)).status).toBe(200);
    expect(await status("reader@example.com")).toEqual({ status: "pending", consent_source: null });
    const link = String(calls[0].get("text")).match(/\/confirm\?t=(\S+)/)!;

    // Scanners prefetch GET links; that must not confirm.
    await worker.fetch(new Request(`${env.PUBLIC_URL}/confirm?t=${link[1]}`), env);
    expect((await status("reader@example.com")).status).toBe("pending");

    expect((await post(`/confirm?t=${link[1]}`)).status).toBe(200);
    expect(await status("reader@example.com")).toEqual({ status: "active", consent_source: "form" });

    // Already active: same page, no email.
    expect((await post("/subscribe", form)).status).toBe(200);
    expect(calls).toHaveLength(1);

    const oneClick = await post(`/unsubscribe?t=${link[1]}`, { "List-Unsubscribe": "One-Click" });
    expect(oneClick.status).toBe(200);
    expect((await status("reader@example.com")).status).toBe("unsubscribed");

    await post("/subscribe", form);
    expect((await status("reader@example.com")).status).toBe("pending");
    expect(calls).toHaveLength(2);
  });

  it("rejects a bad address and a failed Turnstile check", async () => {
    expect((await post("/subscribe", { email: "nope", "cf-turnstile-response": "ok" })).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false }));
    expect((await post("/subscribe", { email: "a@b.co", "cf-turnstile-response": "bad" })).status).toBe(400);
    expect(await status("a@b.co")).toEqual({});
  });
});
