import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { FLAG_AFTER_MS, parseFeed, STALE_MS, tick } from "../src/send";

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
    if (url === env.FEED_URL) return feedXml === null ? new Response("down", { status: 503 }) : new Response(feedXml);
    if (url.endsWith("/messages")) {
      const form = init!.body as FormData;
      calls.push(form);
      return mailgunReply(form, calls.length);
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

  it("alerts once about a refused batch, however many ticks retry it", async () => {
    await addSubscribers(1, "a");
    await publishNewPost();
    // A proxy can answer with a whole HTML page instead of Mailgun's JSON.
    mailgunReply = (f) => (f.has("v:batch") ? new Response(`bad key ${"x".repeat(5000)}`, { status: 401 }) : Response.json({}));
    await tick(env, NOW);
    await tick(env, NOW + 3600_000);
    expect(issueCalls()).toHaveLength(2); // still retrying
    expect(alertCalls()).toHaveLength(1);
    expect(alertCalls()[0].get("text")).toContain("HTTP 401: bad key");
    expect(String(alertCalls()[0].get("text")).length).toBeLessThan(1000); // body truncated
    expect(await env.DB.prepare("SELECT failed_alerted_at FROM batches").first("failed_alerted_at")).toBe(NOW);

    await tick(env, NOW + 7200_000);
    expect(alertCalls()).toHaveLength(1);
  });

  it("retries the refused-batch alert until it sends", async () => {
    await addSubscribers(1, "a");
    await publishNewPost();
    mailgunReply = (f) =>
      f.has("v:batch")
        ? new Response("bad key", { status: 401 })
        : alertCalls().length === 1
          ? new Response("no", { status: 500 }) // the first alert doesn't get through
          : Response.json({});
    await tick(env, NOW);
    expect(alertCalls()).toHaveLength(1);
    await tick(env, NOW + 3600_000);
    await tick(env, NOW + 7200_000);
    expect(alertCalls()).toHaveLength(2);
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
    await tick(env, NOW);
    await Promise.all([tick(env, NOW + 3600_000), tick(env, NOW + 3600_000)]);
    expect(issueCalls()).toHaveLength(4);
  });

  it("marks a retried batch sent without calling Mailgun when everyone in it has left", async () => {
    await addSubscribers(3, "a");
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
    await Promise.all([tick(env, NOW), tick(env, NOW), tick(env, NOW)]);
    expect(recipients()).toHaveLength(2500);
    expect(new Set(recipients()).size).toBe(2500);
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
