# At-most-once delivery: ambiguous batches are flagged, not retried

A batch is marked `in_flight` before it goes to Mailgun, and it's marked `sent` only after Mailgun accepts it. If the Worker dies or the connection drops in between, nothing can tell whether Mailgun accepted the batch, and Mailgun has no idempotency key to ask. We chose at-most-once delivery: a batch still in flight after 15 minutes becomes `flagged`, the admin gets one email, and a person decides with one SQL command whether to mark it `sent` or `failed`. A duplicate issue lands in every recipient's inbox and looks sloppy. A flagged miss is rare, shows up right away, and can be fixed by hand.

## Consequences

- Only a Mailgun HTTP error response counts as a clear failure (`failed`, retried on the next tick). A thrown `fetch` (timeout, reset) counts as ambiguous, even though some of those errors happen before the request leaves the Worker.
- Resolving a flag needs Mailgun's logs. Each batch carries the user variable `batch=<id>`, and Mailgun's log retention can be short, so act on alerts within days.
- Recipients are tracked with a per-issue cursor over subscriber IDs, not a per-recipient snapshot. That's why a batch is identified by its ID range and why subscriber IDs must never be reused.
