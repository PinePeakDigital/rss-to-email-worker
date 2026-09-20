import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { batchSize, DEFAULT_BATCH_SIZE, fetchSuppressions, fitImages, FLAG_AFTER_MS, MAX_CONSECUTIVE_FAILURES, MAX_SUPPRESSIONS_PER_TICK, parseFeed, STALE_MS, suppress, SUPPRESSION_PAGES, tick } from "../src/send";

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

let feedXml: string | null; // null: the feed host is down
let calls: FormData[];
let mailgunReply: (form: FormData, n: number) => Response | Promise<Response>;
let bounces: { address: string }[];
let complaints: { address: string }[];
let suppressionReply: ((list: string) => Response | null) | null;

const issueCalls = () => calls.filter((f) => f.has("v:batch"));
const alertCalls = () => calls.filter((f) => f.get("to") === env.ADMIN_EMAIL);
const recipients = () => issueCalls().flatMap((f) => f.getAll("to") as string[]);
/** The opt-in path: one provider call per 1000 recipients, as before individual sending. */
const batched = { ...env, BATCH_SIZE: 1000 };

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
  bounces = [];
  complaints = [];
  suppressionReply = null;
  await env.DB.batch(["batches", "items", "subscribers"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === env.FEED_URL) return feedXml === null ? new Response("down", { status: 503 }) : new Response(feedXml);
    if (url.endsWith("/messages")) {
      const form = init!.body as FormData;
      calls.push(form);
      return mailgunReply(form, calls.length);
    }
    for (const list of ["bounces", "complaints"]) {
      if (url.includes(`/${list}`)) {
        const override = suppressionReply?.(list);
        if (override) return override;
        // Mailgun returns paging.next even on the last page, so a short page is the only real end.
        return Response.json({
          items: list === "bounces" ? bounces : complaints,
          paging: { next: `https://api.mailgun.net/v3/d/${list}?page=next` },
        });
      }
    }
    if (url.includes("turnstile")) return Response.json({ success: true, action: "subscribe", hostname: "example.com" });
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
    expect(issueCalls()).toHaveLength(3); // one call per recipient, not one batch
    const form = issueCalls()[1];
    expect(form.getAll("to")).toEqual(["a2@x.test"]);
    expect(form.get("subject")).toBe("Post new");
    expect(form.get("html")).toContain("<p>Body of new</p>");
    // The real token, not a batch substitution variable, and no recipient-variables at all.
    expect(form.get("h:List-Unsubscribe")).toBe(`<${env.PUBLIC_URL}/unsubscribe?t=tok-a2>`);
    expect(form.get("html")).toContain(`${env.PUBLIC_URL}/unsubscribe?t=tok-a2`);
    expect(form.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(form.has("recipient-variables")).toBe(false);
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
    await tick(batched, NOW);
    expect(issueCalls()).toHaveLength(3);

    await tick(batched, NOW + 3600_000);
    expect(issueCalls()).toHaveLength(4);
    expect(issueCalls()[3].getAll("to")).toEqual(issueCalls()[1].getAll("to"));

    const delivered = recipients().filter((_, i) => i < 1000 || i >= 2000); // drop the refused batch
    expect(delivered).toHaveLength(2500);
    expect(new Set(delivered).size).toBe(2500);

    await tick(batched, NOW + 7200_000);
    expect(issueCalls()).toHaveLength(4);
  });

  it("flags a send with unknown outcome, alerts once, and never resends it on its own", async () => {
    await addSubscribers(1, "a");
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
    expect(issueCalls()[1].getAll("to")).toEqual(["a1@x.test"]);
  });

  it("includes subscribers who confirm mid-issue and skips those who leave", async () => {
    await addSubscribers(1500, "a"); // batched: the comment below depends on a wide claimed range
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
    await tick(batched, NOW);
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

  it("sends an item dated exactly at the stale cutoff, but not one a millisecond older", async () => {
    await addSubscribers(1, "a");
    feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]);
    await tick(env, NOW);
    feedXml = feed([
      { guid: "old", date: NOW - 30 * DAY },
      { guid: "edge", date: NOW - STALE_MS },
      { guid: "past", date: NOW - STALE_MS - 1000 },
    ]);
    await tick(env, NOW);
    expect(issueCalls().map((f) => f.get("subject"))).toEqual(["Post edge"]);
  });

  it("retries a refused batch once even when ticks overlap", async () => {
    await addSubscribers(2500, "a");
    await publishNewPost();
    mailgunReply = (_f, n) => (n === 2 ? new Response("boom", { status: 500 }) : Response.json({}));
    await tick(batched, NOW);
    await Promise.all([tick(batched, NOW + 3600_000), tick(batched, NOW + 3600_000)]);
    expect(issueCalls()).toHaveLength(4);
  });

  it("marks a retried batch sent without calling Mailgun when everyone in it has left", async () => {
    await addSubscribers(1, "a");
    await publishNewPost();
    mailgunReply = () => new Response("boom", { status: 500 });
    await tick(env, NOW);
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed'").run();
    mailgunReply = () => Response.json({});
    await tick(env, NOW + 3600_000);
    expect(issueCalls()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT status FROM batches").first("status")).toBe("sent");
  });

  it("retries the admin alert until it sends, then stops", async () => {
    await addSubscribers(1, "a");
    await publishNewPost();
    mailgunReply = () => {
      throw new Error("connection reset");
    };
    await tick(env, NOW);
    mailgunReply = (f) => (f.get("to") === env.ADMIN_EMAIL && alertCalls().length === 1 ? new Response("no", { status: 500 }) : Response.json({}));
    await tick(env, NOW + FLAG_AFTER_MS + 1); // alert refused
    await tick(env, NOW + 2 * FLAG_AFTER_MS); // alert sent
    await tick(env, NOW + 3 * FLAG_AFTER_MS);
    expect(alertCalls()).toHaveLength(2);
  });

  it("keeps sending open issues while the feed is down, and still reports the failure", async () => {
    await addSubscribers(1, "a");
    await publishNewPost();
    mailgunReply = () => new Response("boom", { status: 500 });
    await tick(env, NOW);
    feedXml = null;
    mailgunReply = () => Response.json({});
    await expect(tick(env, NOW + 3600_000)).rejects.toThrow(AggregateError);
    expect(issueCalls()).toHaveLength(2);
  });

  it("sends each recipient once when ticks overlap", async () => {
    await addSubscribers(2500, "a");
    await publishNewPost();
    await Promise.all([tick(batched, NOW), tick(batched, NOW), tick(batched, NOW)]);
    expect(recipients()).toHaveLength(2500);
    expect(new Set(recipients()).size).toBe(2500);
  });

  it("sends each recipient once when ticks overlap, sending individually", async () => {
    await addSubscribers(20, "a");
    await publishNewPost();
    await Promise.all([tick(env, NOW), tick(env, NOW), tick(env, NOW)]);
    expect(recipients()).toHaveLength(20);
    expect(new Set(recipients()).size).toBe(20);
  });

  it("resends only the individual recipient the provider refused", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    mailgunReply = (f) => (f.getAll("to").includes("a2@x.test") ? new Response("boom", { status: 500 }) : Response.json({}));
    await tick(env, NOW);
    expect(recipients()).toEqual(["a1@x.test", "a2@x.test", "a3@x.test"]);

    mailgunReply = () => Response.json({});
    await tick(env, NOW + 3600_000);
    expect(recipients().slice(3)).toEqual(["a2@x.test"]); // only the refused one comes back

    await tick(env, NOW + 7200_000);
    expect(issueCalls()).toHaveLength(4);
  });

  it("stops when the send budget is spent and resumes on the next tick", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    await tick(env, NOW, { deadline: Date.now() - 1 }); // budget already gone
    expect(issueCalls()).toHaveLength(0);

    await tick(env, NOW + 3600_000);
    expect(recipients().sort()).toEqual(["a1@x.test", "a2@x.test", "a3@x.test"]);
  });

  it("gives up for this tick once the provider refuses several sends in a row", async () => {
    await addSubscribers(20, "a");
    await publishNewPost();
    mailgunReply = () => new Response("bad key", { status: 401 });
    await tick(env, NOW);
    // Stops at the streak limit instead of logging once per subscriber.
    expect(issueCalls()).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it("doesn't let one issue's refusals block a later one", async () => {
    await addSubscribers(10, "a");
    // Two open issues; the older one is refused for every recipient.
    feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]);
    await tick(env, NOW);
    feedXml = feed([
      { guid: "old", date: NOW - 30 * DAY },
      { guid: "bad", date: NOW - 120_000 },
      { guid: "good", date: NOW - 60_000 },
    ]);
    mailgunReply = (f) => (String(f.get("subject")).includes("bad") ? new Response("nope", { status: 400 }) : Response.json({}));
    await tick(env, NOW);

    // The refusal streak is per send loop, so "good" still goes out in the same tick.
    const good = issueCalls().filter((f) => String(f.get("subject")).includes("good"));
    expect(good).toHaveLength(10);
    expect(issueCalls().filter((f) => String(f.get("subject")).includes("bad"))).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it("flags rather than fails when the connection drops, and still stops at the streak limit", async () => {
    await addSubscribers(20, "a");
    await publishNewPost();
    mailgunReply = () => {
      throw new Error("connection reset");
    };
    await tick(env, NOW);
    expect(issueCalls()).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    // Unknown outcome, so these stay in flight and become flagged — one alert each, not a retry.
    const rows = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM batches GROUP BY status").all<{ status: string; n: number }>();
    expect(rows.results).toEqual([{ status: "in_flight", n: MAX_CONSECUTIVE_FAILURES }]);
  });

  it("keeps sending the rest of an issue even when enough addresses always fail to trip the breaker", async () => {
    await addSubscribers(12, "a");
    await publishNewPost();
    // Interleaved so the first tick never sees a streak, and capped so the issue stays open.
    const dead = ["a1@x.test", "a3@x.test", "a5@x.test", "a7@x.test", "a9@x.test", "a11@x.test"];
    mailgunReply = (f) => (dead.includes(f.getAll("to")[0] as string) ? new Response("bad address", { status: 400 }) : Response.json({}));
    await tick(env, NOW, { sendsLeft: 11 });
    expect(recipients()).toHaveLength(11); // a12 not reached; 6 rows now 'failed'

    // The retry phase burns its whole streak on the dead addresses. a12 must still be sent: a
    // streak ends its phase, not the issue.
    await tick(env, NOW + 3600_000);
    const second = recipients().slice(11);
    expect(second.filter((r) => dead.includes(r))).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(second).toContain("a12@x.test");
  });

  it("stops at the per-tick send cap and resumes on the next tick", async () => {
    await addSubscribers(8, "a");
    await publishNewPost();
    await tick(env, NOW, { sendsLeft: 3 });
    expect(recipients()).toHaveLength(3);

    await tick(env, NOW + 3600_000);
    expect(recipients()).toHaveLength(8);
    expect(new Set(recipients()).size).toBe(8);
  });

  it("charges the budget for a retry range even when everyone in it has left", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    mailgunReply = () => new Response("boom", { status: 500 });
    await tick(env, NOW, { sendsLeft: 3 }); // 3 sends, all refused -> 3 'failed' rows
    expect(issueCalls()).toHaveLength(3);

    // Nobody is left in any range, so these retries make no provider call at all. They still cost
    // the D1 queries that claiming them spent, so the budget must stop after two of the three.
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed'").run();
    mailgunReply = () => Response.json({});
    await tick(env, NOW + 3600_000, { sendsLeft: 2 });
    expect(issueCalls()).toHaveLength(3); // still no new calls
    const done = await env.DB.prepare("SELECT COUNT(*) AS n FROM batches WHERE status = 'sent'").first<{ n: number }>();
    expect(done?.n).toBe(2);
  });

  it("keeps going when failures are not consecutive", async () => {
    await addSubscribers(20, "a");
    await publishNewPost();
    mailgunReply = (_f, n) => (n % 2 === 0 ? new Response("boom", { status: 500 }) : Response.json({}));
    await tick(env, NOW);
    expect(issueCalls()).toHaveLength(20); // every other one fails, so the streak never reaches the limit
  });
});

describe("suppress", () => {
  const statusOf = async (email: string) =>
    env.DB.prepare("SELECT status, unsubscribe_reason AS reason, unsubscribed_at AS at FROM subscribers WHERE email = ?")
      .bind(email)
      .first<{ status: string; reason: string | null; at: number | null }>();

  it("stops sending to a bounced or complaining address and records which", async () => {
    await addSubscribers(3, "a");
    expect(
      await suppress(env, [
        { email: "a1@x.test", reason: "bounce" },
        { email: "A2@X.TEST", reason: "complaint" }, // provider casing must still match
      ], NOW),
    ).toBe(2);

    expect(await statusOf("a1@x.test")).toEqual({ status: "unsubscribed", reason: "bounce", at: NOW });
    expect(await statusOf("a2@x.test")).toEqual({ status: "unsubscribed", reason: "complaint", at: NOW });
    expect((await statusOf("a3@x.test"))?.status).toBe("active");
  });

  it("leaves someone who already left alone, keeping their original reason", async () => {
    await addSubscribers(1, "a");
    await suppress(env, [{ email: "a1@x.test", reason: "complaint" }], NOW);
    expect(await suppress(env, [{ email: "a1@x.test", reason: "bounce" }], NOW + DAY)).toBe(0);
    expect(await statusOf("a1@x.test")).toEqual({ status: "unsubscribed", reason: "complaint", at: NOW });
  });

  it("ignores an address it doesn't have, but does suppress a pending one", async () => {
    await addSubscribers(1, "p", "pending");
    // A typo'd address that bounced would otherwise sit pending forever, collecting a fresh
    // confirmation email every time someone tried to subscribe it.
    expect(
      await suppress(env, [
        { email: "nobody@x.test", reason: "bounce" },
        { email: "p1@x.test", reason: "bounce" },
      ], NOW),
    ).toBe(1);
    expect(await statusOf("p1@x.test")).toEqual({ status: "unsubscribed", reason: "bounce", at: NOW });
  });

  // Whichever order the lists arrive in: a complaint is the more meaningful of the two.
  it.each([
    ["bounce first", ["bounce", "complaint"]],
    ["complaint first", ["complaint", "bounce"]],
  ] as const)("prefers complaint over bounce when an address is on both lists, %s", async (_name, order) => {
    await addSubscribers(1, "a");
    await suppress(env, order.map((reason) => ({ email: "a1@x.test", reason })), NOW);
    expect((await statusOf("a1@x.test"))?.reason).toBe("complaint");
  });

  it("applies at most a tick's worth and leaves the rest for the next one", async () => {
    await addSubscribers(MAX_SUPPRESSIONS_PER_TICK + 10, "a");
    const all = Array.from({ length: MAX_SUPPRESSIONS_PER_TICK + 10 }, (_, i) => ({
      email: `a${i + 1}@x.test`,
      reason: "bounce" as const,
    }));
    expect(await suppress(env, all, NOW)).toBe(MAX_SUPPRESSIONS_PER_TICK);
    expect(await suppress(env, all, NOW + DAY)).toBe(10);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps a provider reason when the reader later clicks unsubscribe", async () => {
    await addSubscribers(1, "a");
    await suppress(env, [{ email: "a1@x.test", reason: "complaint" }], NOW);
    const token = await env.DB.prepare("SELECT token FROM subscribers WHERE email = 'a1@x.test'").first<string>("token");
    const res = await worker.fetch(new Request(`${env.PUBLIC_URL}/unsubscribe?t=${token}`, { method: "POST" }), env);
    expect(res.status).toBe(200);
    // The complaint is the record worth keeping; 'self' must not overwrite it.
    expect(await statusOf("a1@x.test")).toEqual({ status: "unsubscribed", reason: "complaint", at: NOW });
  });

  it("records 'self' when an active subscriber unsubscribes", async () => {
    await addSubscribers(1, "a");
    const token = await env.DB.prepare("SELECT token FROM subscribers WHERE email = 'a1@x.test'").first<string>("token");
    await worker.fetch(new Request(`${env.PUBLIC_URL}/unsubscribe?t=${token}`, { method: "POST" }), env);
    expect((await statusOf("a1@x.test"))?.reason).toBe("self");
  });

  it("never sends to a suppressed subscriber again", async () => {
    await addSubscribers(3, "a");
    await suppress(env, [{ email: "a2@x.test", reason: "complaint" }], NOW);
    await publishNewPost();
    await tick(env, NOW);
    expect(recipients().sort()).toEqual(["a1@x.test", "a3@x.test"]);
  });
});

describe("fetchSuppressions", () => {
  it("reads both lists once each, despite a next link on the last page", async () => {
    bounces = [{ address: "dead@x.test" }];
    complaints = [{ address: "angry@x.test" }];
    expect(await fetchSuppressions(env)).toEqual({
      entries: [
        { email: "dead@x.test", reason: "bounce" },
        { email: "angry@x.test", reason: "complaint" },
      ],
      failures: [],
    });
  });

  it("returns what it could read, and names the list it could not", async () => {
    complaints = [{ address: "angry@x.test" }];
    suppressionReply = (list) => (list === "bounces" ? new Response("nope", { status: 500 }) : null);
    expect(await fetchSuppressions(env)).toEqual({
      entries: [{ email: "angry@x.test", reason: "complaint" }],
      failures: ["bounces HTTP 500"],
    });
  });

  it("skips items whose address isn't a string, and fails on a malformed page", async () => {
    // A well-behaved API shouldn't do either, but one bad item must not kill the whole phase.
    suppressionReply = (list) =>
      list === "bounces"
        ? Response.json({ items: [{ address: 42 }, { address: null }, {}, { address: "ok@x.test" }], paging: {} })
        : Response.json({ items: "not an array", paging: {} });
    const { entries, failures } = await fetchSuppressions(env);
    expect(entries).toEqual([{ email: "ok@x.test", reason: "bounce" }]);
    expect(failures).toEqual(["complaints malformed"]);
  });

  it("treats an unreadable body as a failure, not an empty list", async () => {
    suppressionReply = () => new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
    const { entries, failures } = await fetchSuppressions(env);
    expect(entries).toEqual([]);
    expect(failures).toEqual(["bounces unparseable", "complaints unparseable"]);
  });

  it("stops after the page cap instead of following pages forever", async () => {
    let pages = 0;
    // A full page plus a next link: without the cap this would never terminate.
    suppressionReply = (list) => {
      if (list !== "bounces") return null;
      pages++;
      return Response.json({
        items: Array.from({ length: 1000 }, (_, i) => ({ address: `b${pages}-${i}@x.test` })),
        paging: { next: "https://api.mailgun.net/v3/d/bounces?page=next" },
      });
    };
    const { entries } = await fetchSuppressions(env);
    expect(pages).toBe(SUPPRESSION_PAGES);
    expect(entries).toHaveLength(SUPPRESSION_PAGES * 1000);
  });

  it("suppresses during a tick, before that address would be sent to", async () => {
    await addSubscribers(3, "a");
    await publishNewPost();
    bounces = [{ address: "a2@x.test" }];
    await tick(env, NOW);
    expect(recipients().sort()).toEqual(["a1@x.test", "a3@x.test"]);
    const row = await env.DB.prepare("SELECT status, unsubscribe_reason AS r FROM subscribers WHERE email = 'a2@x.test'").first<{
      status: string;
      r: string;
    }>();
    expect(row).toEqual({ status: "unsubscribed", r: "bounce" });
  });

  it("keeps sending when the suppression lists are unreachable, but reports the failure", async () => {
    await addSubscribers(2, "a");
    await publishNewPost();
    suppressionReply = () => new Response("down", { status: 503 });
    await expect(tick(env, NOW)).rejects.toThrow(AggregateError);
    expect(recipients().sort()).toEqual(["a1@x.test", "a2@x.test"]);
  });

  it("applies the list it could read even when the other one fails", async () => {
    await addSubscribers(2, "a");
    await publishNewPost();
    complaints = [{ address: "a1@x.test" }];
    suppressionReply = (list) => (list === "bounces" ? new Response("down", { status: 503 }) : null);
    await expect(tick(env, NOW)).rejects.toThrow(AggregateError);
    expect(recipients()).toEqual(["a2@x.test"]);
  });
});

describe("fitImages", () => {
  const FIT = "max-width:100%;height:auto";

  it("constrains an image sized for the web, keeping its other attributes", () => {
    // Exactly what the feed emits: correct web markup that an email has no stylesheet to size.
    const got = fitImages('<figure><img src="https://x.test/1.webp" alt="" width="1024" height="608" loading="eager"></figure>');
    expect(got).toBe(
      `<figure><img src="https://x.test/1.webp" alt="" width="1024" height="608" loading="eager" style="${FIT}"></figure>`,
    );
  });

  it("appends to an existing style so its own declaration wins", () => {
    expect(fitImages(`<img src="a.png" style="border-radius:8px">`)).toBe(
      `<img src="a.png" style="border-radius:8px;${FIT}">`,
    );
    // A width the feed set for the web must not survive, or the image still blows out.
    expect(fitImages(`<img src="a.png" style="max-width:1024px;">`)).toBe(`<img src="a.png" style="max-width:1024px;${FIT}">`);
  });

  it("handles self-closing tags, single quotes and several images", () => {
    expect(fitImages(`<img src='a.png'/><p>x</p><img src="b.png">`)).toBe(
      `<img src='a.png' style="${FIT}"/><p>x</p><img src="b.png" style="${FIT}">`,
    );
  });

  it("leaves everything that isn't an image alone", () => {
    const prose = '<p>An <a href="https://x.test">image</a> of a word: img.</p>';
    expect(fitImages(prose)).toBe(prose);
  });

  it("reaches the sent email", async () => {
    await addSubscribers(1, "a");
    feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]);
    await tick(env, NOW);
    feedXml = feed([{ guid: "old", date: NOW - 30 * DAY }]).replace(
      "<p>Body of old</p>",
      '<p>Body</p><img src="https://x.test/hero.webp" width="1024" height="608">',
    );
    // The feed above only has "old"; publish a genuinely new item carrying an image.
    feedXml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>${
      `<item><title>Post new</title><link>https://example.com/new</link><guid>https://example.com/new</guid>` +
      `<pubDate>${new Date(NOW - 60_000).toUTCString()}</pubDate>` +
      `<content:encoded><![CDATA[<figure><img src="https://x.test/hero.webp" width="1024" height="608"></figure>]]></content:encoded></item>`
    }</channel></rss>`;
    await tick(env, NOW);
    expect(issueCalls()[0].get("html")).toContain(`width="1024" height="608" style="${FIT}"`);
  });
});

describe("batchSize", () => {
  it("defaults to one and clamps anything out of range", () => {
    expect(batchSize({ ...env, BATCH_SIZE: undefined })).toBe(DEFAULT_BATCH_SIZE); // unset, not 1-from-wrangler.jsonc
    expect(batchSize(env)).toBe(DEFAULT_BATCH_SIZE);
    expect(batchSize({ ...env, BATCH_SIZE: 1000 })).toBe(1000);
    expect(batchSize({ ...env, BATCH_SIZE: "250" })).toBe(250);
    for (const bad of [0, -5, 1001, 2.5, "abc", ""]) {
      expect(batchSize({ ...env, BATCH_SIZE: bad })).toBe(DEFAULT_BATCH_SIZE);
    }
  });
});

describe("parseFeed", () => {
  const rss = (item: string) => `<rss version="2.0"><channel><title>t</title><item>${item}</item></channel></rss>`;

  it("reads a guid with attributes, and treats a single item as a list", () => {
    const [item] = parseFeed(rss('<guid isPermaLink="false">abc</guid><title>2026</title><pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate>'));
    expect(item.guid).toBe("abc");
    expect(item.title).toBe("2026"); // stays a string, not a number
    expect(item.pubDate).toBe(NOW);
  });

  it("falls back to link for guid and description for body; missing pubDate is NaN", () => {
    const [item] = parseFeed(rss("<link>https://x.test/a</link><description>&lt;p&gt;hi&lt;/p&gt;</description>"));
    expect(item.guid).toBe("https://x.test/a");
    expect(item.html).toBe("<p>hi</p>");
    expect(item.pubDate).toBeNaN();
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

  it("unsubscribes via the page button, and rejects unknown tokens", async () => {
    await addSubscribers(1, "a");
    const res = await post("/unsubscribe?t=tok-a1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed</h1>");
    expect((await status("a1@x.test")).status).toBe("unsubscribed");
    expect((await post("/unsubscribe?t=nope")).status).toBe(404);
    expect((await post("/confirm?t=nope")).status).toBe(404);
  });

  it("rejects a bad address, and a Turnstile token that failed or came from another form or site", async () => {
    expect((await post("/subscribe", { email: "nope", "cf-turnstile-response": "ok" })).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false }));
    expect((await post("/subscribe", { email: "a@b.co", "cf-turnstile-response": "bad" })).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, action: "login", hostname: "example.com" }));
    expect((await post("/subscribe", { email: "a@b.co", "cf-turnstile-response": "other-form" })).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, action: "subscribe", hostname: "evil.test" }));
    expect((await post("/subscribe", { email: "a@b.co", "cf-turnstile-response": "other-site" })).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>error</html>"));
    expect((await post("/subscribe", { email: "a@b.co", "cf-turnstile-response": "garbled" })).status).toBe(400);
    expect(await status("a@b.co")).toEqual({});
  });

  it("accepts a token from the www host", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: true, action: "subscribe", hostname: "www.example.com" }));
    expect((await post("/subscribe", { email: "w@b.co", "cf-turnstile-response": "ok" })).status).toBe(200);
  });
});
