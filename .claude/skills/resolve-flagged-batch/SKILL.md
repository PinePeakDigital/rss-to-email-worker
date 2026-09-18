---
name: resolve-flagged-batch
description: Resolve a flagged newsletter batch (one whose delivery outcome is unknown) by checking Mailgun's logs and marking it sent or failed in D1. Use when a "Batch N needs a decision" alert arrives.
---

A **flagged batch** was handed to Mailgun, but its outcome was never recorded. It is never retried automatically (see `docs/adr/0001-at-most-once-delivery.md`). Your job is to find out whether Mailgun accepted it, then record that.

1. **Find the batch.** Use the ID from the alert, or list every open flag:
   `npx wrangler d1 execute DB --remote --command "SELECT id, guid, after_id, last_id, datetime(started_at / 1000, 'unixepoch') AS started FROM batches WHERE status = 'flagged'"`
2. **Check Mailgun.** Query events for the sending domain around `started`, filtered by the user variable `batch`. This needs `MAILGUN_API_KEY`; ask the user for it, never print it.
   `curl -s --user "api:$MAILGUN_API_KEY" -G "https://api.mailgun.net/v3/<MAILGUN_DOMAIN>/events" --data-urlencode 'user-variables={"batch":"<id>"}' --data-urlencode 'event=accepted'`
   - Take `MAILGUN_DOMAIN` and the API base from `wrangler.jsonc`.
   - `accepted` events for the batch's recipients mean Mailgun took it. No events means it didn't.
   - If the logs have expired or the result is unclear, stop and tell the user. Don't guess.
3. **Show the evidence to the user and get their go-ahead,** then record the outcome.
   - Accepted: `npx wrangler d1 execute DB --remote --command "UPDATE batches SET status = 'sent' WHERE id = <id> AND status = 'flagged'"`
   - Not accepted: the same command with `status = 'failed'`. The next hourly tick resends the batch to the active subscribers in its range.
   - A partial acceptance can't be split. Report it to the user and let them choose.
