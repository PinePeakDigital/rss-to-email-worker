import { type Env, esc, mailgun, tick } from "./send";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const token = url.searchParams.get("t") ?? "";
    switch (`${req.method} ${url.pathname}`) {
      case "POST /subscribe":
        return subscribe(req, env);
      // GET only shows a button: link scanners prefetch GETs and must not confirm or unsubscribe anyone.
      case "GET /confirm":
        return page(env, "Confirm your subscription", button(`/confirm?t=${token}`, `Subscribe to ${env.SITE_NAME}`));
      case "GET /unsubscribe":
        return page(env, "Unsubscribe", button(`/unsubscribe?t=${token}`, `Unsubscribe from ${env.SITE_NAME}`));
      case "POST /confirm":
        return confirm(env, token);
      case "POST /unsubscribe":
        return unsubscribe(req, env, token);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await tick(env);
  },
} satisfies ExportedHandler<Env>;

async function subscribe(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return page(env, "That doesn't look like an email address", "<p>Go back and check it.</p>", 400);
  }
  if (!(await turnstileOk(env, String(form.get("cf-turnstile-response") ?? ""), req.headers.get("CF-Connecting-IP")))) {
    return page(env, "Couldn't verify you're human", "<p>Go back and try again.</p>", 400);
  }

  // Active stays active; pending or unsubscribed get a (fresh) confirmation email.
  const row = await env.DB.prepare(
    `INSERT INTO subscribers (email, token) VALUES (?, ?)
     ON CONFLICT (email) DO UPDATE SET status = CASE status WHEN 'active' THEN 'active' ELSE 'pending' END
     RETURNING status, token`,
  )
    .bind(email, crypto.randomUUID())
    .first<{ status: string; token: string }>();

  if (row?.status === "pending") {
    const link = `${env.PUBLIC_URL}/confirm?t=${row.token}`;
    const mail = new FormData();
    mail.set("from", env.FROM);
    mail.set("to", email);
    mail.set("subject", `Confirm your subscription to ${env.SITE_NAME}`);
    mail.set("text", `Confirm your subscription to ${env.SITE_NAME}:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`);
    const res = await mailgun(env, mail).catch(() => null);
    if (!res?.ok) return page(env, "Something went wrong", "<p>The confirmation email didn't send. Try again later.</p>", 502);
  }
  // Same response whether or not the address was already subscribed.
  return page(env, "Check your inbox", "<p>Click the link in the email we just sent to confirm your subscription.</p>");
}

async function confirm(env: Env, token: string): Promise<Response> {
  // SET expressions see pre-update values, so an already-active subscriber keeps their original consent.
  const { meta } = await env.DB.prepare(
    `UPDATE subscribers SET
       consent_at = CASE status WHEN 'active' THEN consent_at ELSE ? END,
       consent_source = CASE status WHEN 'active' THEN consent_source ELSE 'form' END,
       status = 'active'
     WHERE token = ?`,
  )
    .bind(Date.now(), token)
    .run();
  if (meta.changes !== 1) return page(env, "Link not recognized", "<p>Try subscribing again.</p>", 404);
  return page(env, "You're subscribed", `<p>New posts from ${esc(env.SITE_NAME)} will arrive by email.</p>`);
}

async function unsubscribe(req: Request, env: Env, token: string): Promise<Response> {
  const { meta } = await env.DB.prepare(
    "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribe_reason = 'self' WHERE token = ?",
  )
    .bind(Date.now(), token)
    .run();
  const form = await req.formData().catch(() => null);
  // RFC 8058 one-click: a mail provider posting on the reader's behalf, nobody to show a page to.
  if (form?.get("List-Unsubscribe") === "One-Click") return new Response(null, { status: meta.changes ? 200 : 404 });
  if (meta.changes !== 1) return page(env, "Link not recognized", "<p>This unsubscribe link isn't valid.</p>", 404);
  return page(env, "You're unsubscribed", `<p>You won't get any more email from ${esc(env.SITE_NAME)}.</p>`);
}

async function turnstileOk(env: Env, response: string, ip: string | null): Promise<boolean> {
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", response);
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body }).catch(
    (e) => (console.error("Turnstile siteverify unreachable", e), null),
  );
  const result = res?.ok
    ? ((await res.json().catch(() => null)) as { success: boolean; action?: string; hostname?: string } | null)
    : null;
  if (!result) return false;
  // A token is only good for the subscribe form on our own site, not one minted elsewhere with this sitekey.
  const site = new URL(env.SITE_URL).hostname.replace(/^www\./, "");
  return result.success && result.action === "subscribe" && [site, `www.${site}`].includes(result.hostname ?? "");
}

function button(action: string, label: string): string {
  return `<form method="post" action="${esc(action)}"><button style="font:inherit;padding:8px 16px">${esc(label)}</button></form>`;
}

function page(env: Env, title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(env.SITE_NAME)}</title></head>
<body style="max-width:36rem;margin:4rem auto;padding:0 1rem;font:18px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff">
<h1>${esc(title)}</h1>${body}<p><a href="${esc(env.SITE_URL)}">${esc(env.SITE_NAME)}</a></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
