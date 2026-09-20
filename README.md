# rss-to-email-worker

Emails new items from an RSS feed to double-opt-in subscribers. It runs on Cloudflare Workers and D1, and sends through Mailgun. Built for the [Narthur Online](https://nathanarthur.com) newsletter, and configurable for any feed.

- **Subscribe:** an HTML form on your site, protected by Turnstile, with double opt-in. The consent time and source are recorded.
- **Send:** an hourly cron fetches the feed and emails each new item, as a full post in a light template, to every active subscriber. It sends one message per recipient by default, because Mailgun refuses large batches from a new sending domain (`403 … is not allowed to send large batches yet`) quietly enough to be easy to miss. Set `BATCH_SIZE` up to 1,000 to batch once yours is allowed — which, since Mailgun documents none of this and exposes no way to query it, you can only learn by trying. See [ADR 0002](docs/adr/0002-send-individually-by-default.md).
- **Unsubscribe:** a tokenized link in every email, plus RFC 8058 one-click `List-Unsubscribe` headers, which Gmail and Yahoo require from bulk senders.

## How sending stays correct

This is the part worth reading, and `test/worker.test.ts` covers it.

- **An item is never considered twice.** Its GUID is recorded the first time it's seen. On the first run, everything already in the feed is recorded without sending. After that, items whose `pubDate` is more than 7 days old (backfills and most renames) are recorded without sending.
- **Each issue sends in batches, claimed in order.** A batch covers a range of subscriber IDs above the issue's cursor — one ID at the default `BATCH_SIZE` of 1. A unique `(item, range start)` row plus a transaction means overlapping cron runs can't claim the same range. When no active subscriber is left above the cursor, the issue closes, so people who subscribe later don't receive old issues.
- **A long list spreads over ticks.** Sending is sequential, so a tick stops after ten minutes and the next one resumes from the cursor, rather than being killed mid-issue by the cron wall-clock limit — which would leave every claimed range flagged. A tick also stops sending after five refusals in a row, per phase: a revoked key costs five log lines rather than one per subscriber. A dropped connection is worse — those sends have an unknown outcome, so five of them mean five flagged sends and five alert emails to resolve by hand. A tick also stays inside D1's limit of 1,000 queries per Worker invocation: ingest, suppression and sending all draw from one query budget and stop when it runs out, rather than each carrying a separate cap. Claiming and sending one range costs five, so an issue takes several ticks: roughly an hour per 180-odd subscribers, fewer when the feed or the suppression lists gave the tick more to do.
- **Bounces and complaints stop sending.** Each tick reads Mailgun's bounce and complaint lists and marks those subscribers unsubscribed, recording which of the two it was. Mailgun already refuses to deliver to those addresses on its own, so this is hygiene rather than protection: it stops the Worker spending a send on a dead address, and it keeps a local record of who complained. Self-unsubscribes are recorded the same way, with reason `self`.
- **Delivery is at most once.** If Mailgun returns an error, the batch is retried on the next tick. If the outcome is unknown (the Worker died or the connection dropped mid-request), the batch is **flagged**: it's never retried automatically, and you get one email with the exact command to resolve it. See [ADR 0001](docs/adr/0001-at-most-once-delivery.md). With Claude Code, the `resolve-flagged-batch` skill in `.claude/skills/` does the Mailgun log check for you.

The domain vocabulary is defined in [CONTEXT.md](CONTEXT.md).

## Deploy your own

You need a Cloudflare account, a Mailgun account with a verified sending domain (SPF, DKIM and DMARC set up), and a Turnstile widget.

1. `npm install`.
2. Replace the placeholder `vars` and `routes` in `wrangler.jsonc`. Or, to keep your values out of a fork you publish, copy the file to `wrangler.<name>.jsonc` (gitignored) and add `-c wrangler.<name>.jsonc` to the wrangler commands below (`npm run deploy -- -c …`). Set: the feed URL, the Worker's public URL, the site name and URL, the From address, the admin email, and the Mailgun domain. Use `https://api.eu.mailgun.net` for EU-region Mailgun.
3. Set the secrets: `npx wrangler secret put MAILGUN_API_KEY` and `npx wrangler secret put TURNSTILE_SECRET`.
4. `npm run deploy`, then `npm run db:migrate`. The first deploy creates the D1 database. Wrangler may offer to write its ID into `wrangler.jsonc`; discard that change, since later deploys don't need it. The Worker's first cron tick fails until the migration has run, and the next tick picks up from there.
5. **Wait for the first cron tick,** or trigger it from the dashboard, before publishing anything new. It records the current feed as already sent.

### Subscribe form

```html
<form method="post" action="https://mail.example.com/subscribe">
  <input type="email" name="email" required placeholder="you@example.com">
  <div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY" data-action="subscribe"></div>
  <button>Subscribe</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

The Worker accepts a token only if its action is `subscribe` and its hostname is `SITE_URL`'s host with or without `www.`. Allow those hostnames on the Turnstile widget.

### Importing from Substack

```sh
node scripts/import-substack.mjs email_list.csv > import.sql
npx wrangler d1 execute DB --remote --file import.sql
```

Imported subscribers are active, with consent source `substack-import` and their Substack signup date. Tell them about the move in your first issue: every issue carries an unsubscribe link.

## Known limits

- If a post's GUID changes within 7 days of publishing (a renamed file, say), the post is sent again.
- Scheduling is the feed's job. A future-dated item that's in the feed gets sent on the next tick.
- Images in a post are constrained to the email's width, but nothing converts their format. A feed serving WebP or AVIF will render in most clients and not in Outlook on Windows.
- At the default `BATCH_SIZE` of 1, a tick delivers as many messages as its query budget allows — around 180, fewer when the feed or the suppression lists gave it more to do — so a list of a few hundred takes several hours to receive an issue and a few thousand takes a day. Batching is about a thousand times cheaper per recipient in D1 queries, so raise `BATCH_SIZE` as soon as Mailgun allows it — well before the list makes the wait a problem. Note the refusal is about *large* batches, so a modest size may be accepted long before 1,000 is; test upward against addresses you control, and see ADR 0002 for how to recover the rows a refused attempt leaves behind.
- An address Mailgun permanently rejects is retried every tick forever. Five such addresses on one issue consume that issue's whole retry phase each tick.

## Development

`npm test` runs the suite in the Workers runtime against a local D1. `npm run dev` runs the Worker locally. `npx wrangler dev --test-scheduled`, then `curl localhost:8787/__scheduled`, runs a tick by hand.
