# Send one message per recipient by default

Mailgun refuses batch sends from a sending domain it hasn't cleared, and the refusal is easy to miss: the batch is marked `failed`, retried on the next tick, and retried again, while the cron run reports success. A new deployment can sit there sending nothing. Anyone standing this up on a fresh domain hits it, so the default should be the mode that works on day one.

`BATCH_SIZE` now sets recipients per provider call and defaults to 1. Raise it, up to the provider's limit of 1,000, once the domain is cleared for batch sending.

A single-recipient message carries no `recipient-variables` and its real unsubscribe token rather than `%recipient.token%`. That field is what marks a message as a batch send, and sending one at a time is pointless if the request still looks like a batch. Which of the two — multiple `to` addresses or the presence of `recipient-variables` — actually triggers the refusal was not established, so the code avoids both.

## Consequences

- One provider call per recipient, and one `batches` row per recipient per issue. At a few thousand subscribers this is unremarkable; the bookkeeping is unchanged, just finer.
- A flagged send now strands one person instead of up to 1,000, which makes [ADR 0001](0001-at-most-once-delivery.md)'s at-most-once tradeoff cheaper: resolving a flag by hand affects one inbox.
- Sending is sequential, which is also the rate limit — roughly three per second, inside Mailgun's per-minute allowance. No explicit pacing.
- A long list can outrun the cron wall-clock limit, so a tick stops after `SEND_BUDGET_MS` and the next resumes from the cursor. Without it, every range still in flight when the Worker is killed would be flagged.
- A tick stops after `MAX_CONSECUTIVE_FAILURES` refusals in a row. One call per recipient means a provider outage would otherwise log once per subscriber, which is a bill once `console.error` reaches an error tracker.
- Delivery of a large issue takes several ticks, so it is slower to finish than a batched send. That is the cost of the default working without configuration.
