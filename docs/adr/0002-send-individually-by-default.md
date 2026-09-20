# Send one message per recipient by default

Mailgun refuses batch sends from a sending domain it hasn't cleared, and the refusal is easy to miss: the batch is marked `failed`, retried on the next tick, and retried again, while the cron run reports success. A new deployment can sit there sending nothing. Anyone standing this up on a fresh domain hits it, so the default should be the mode that works on day one.

`BATCH_SIZE` now sets recipients per provider call and defaults to 1. Raise it, up to the provider's limit of 1,000, once the domain is cleared for batch sending.

A single-recipient message carries no `recipient-variables` and its real unsubscribe token rather than `%recipient.token%`. Which of the two — several `to` addresses, or the presence of `recipient-variables` — actually triggers the refusal was never established, and sending one at a time is pointless if the request still looks like a batch, so the code avoids both.

## Consequences

- One provider call per recipient, and one `batches` row per recipient per issue. At a few thousand subscribers this is unremarkable; the bookkeeping is unchanged, just finer.
- A flagged send now strands one person instead of up to 1,000, which makes [ADR 0001](0001-at-most-once-delivery.md)'s at-most-once tradeoff cheaper: resolving a flag by hand affects one inbox.
- Sending is sequential, which is also the rate limit — roughly three per second, inside Mailgun's per-minute allowance. No explicit pacing. Mailgun's rate limit is not the binding constraint, though: each send costs about five subrequests against Cloudflare's per-invocation ceiling of 10,000, so `MAX_SENDS_PER_TICK` caps a tick at 1,500 messages. Exceeding the ceiling throws mid-send and strands a claimed range, so the cap exists to stop short of it rather than to pace anything.
- A long list can outrun the cron wall-clock limit, so a tick stops after `SEND_BUDGET_MS` and the next resumes from the cursor. Without it, every range still in flight when the Worker is killed would be flagged.
- A tick stops sending after `MAX_CONSECUTIVE_FAILURES` refusals in a row. One call per recipient means a provider outage would otherwise log once per subscriber, which is a bill once `console.error` reaches an error tracker.
- The streak is counted per send loop, and hitting it in the retry phase ends that phase rather than the issue. Sharing one count across a tick would let a few permanently rejected addresses stop every issue published afterwards, and ending the issue on it would stop that issue ever reaching a new subscriber. Both were found in review of this change.
- A refusal is cheap — the send is marked `failed` and retried — but a dropped connection is not: its outcome is unknown, so the breaker's five sends become five flagged sends and five admin alerts to resolve by hand. That is a worse aggregate than the one alert per 1,000-recipient batch it replaces, though it is bounded per tick.
- Delivery of a large issue takes several ticks, so it is slower to finish than a batched send. That is the cost of the default working without configuration.
