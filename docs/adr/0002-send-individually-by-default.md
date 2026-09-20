# Send one message per recipient by default

Mailgun refuses large batch sends from a new sending domain, and the refusal is easy to miss: the batch is marked `failed`, retried on the next tick, and retried again, while the cron run reports success. A new deployment can sit there sending nothing. Anyone standing this up on a fresh domain hits it, so the default should be the mode that works on day one.

The refusal observed in production:

```
HTTP 403 {"message":"Domain mail.example.com is not allowed to send large batches yet"}
```

`BATCH_SIZE` now sets recipients per provider call and defaults to 1. Raise it, up to Mailgun's limit of 1,000 recipients per batch, when the domain is allowed to batch.

That message settles what the gate is: recipient count, not the `recipient-variables` field. Nothing else about it is knowable. Mailgun documents no such restriction at all — neither the batch-sending page nor the `POST /v3/<domain>/messages` reference mentions domain age, verification, plan or reputation as affecting batch sending — so the threshold ("large"), the schedule, and the criteria are all undocumented, and no API reports whether batching is currently permitted. The word "yet" is the only indication that it lifts.

**So there is no signal to wait for. The only way to know is to send a batch and read the response.** Two adjacent things *are* checkable and worth confirming first, though neither is the batch gate: `GET /v4/domains/<domain>` reports `state` as `active`, `unverified` or `disabled`, and an unverified domain is separately capped at 300 messages a day.

A single-recipient message still carries no `recipient-variables`, and its real unsubscribe token rather than `%recipient.token%`. That field is meaningless for one recipient, so dropping it costs nothing and keeps the request plainly outside whatever Mailgun classifies as a batch.

## Recovering from a raised `BATCH_SIZE` that was refused

Raising `BATCH_SIZE` is an experiment, and the retry path re-sends a `failed` range whole rather than re-chunking it to the current setting. Lowering the value back therefore does not drain rows claimed at the higher one: they keep being retried as wide batches and keep being refused.

Splitting them in code is not worth it. Splitting a 1,000-wide range into single-recipient rows costs 1,000 D1 statements, which exceeds the per-invocation limit by itself; splitting one chunk per tick would take thousands of ticks to drain; and chunking under a single row breaks at-most-once, because a failure partway through re-sends the earlier chunks on the next attempt.

A 403 delivers nothing, though, so the rows can simply be discarded and the ground recovered:

```sh
# The lowest subscriber id any refused range covers, per issue.
npx wrangler d1 execute DB --remote --command \
  "SELECT guid, MIN(after_id) AS rewind FROM batches WHERE status = 'failed' GROUP BY guid"

# Drop the refused ranges and rewind that issue's cursor to before them.
npx wrangler d1 execute DB --remote --command \
  "DELETE FROM batches WHERE guid = '<guid>' AND status = 'failed'"
npx wrangler d1 execute DB --remote --command \
  "UPDATE items SET cursor = <rewind>, done_at = NULL WHERE guid = '<guid>'"
```

The next tick re-covers those subscribers at the current `BATCH_SIZE`. Only do this for ranges refused with a 403; a range that failed for another reason may have been delivered, which is what `flagged` exists for.

## Consequences

- One provider call per recipient, and one `batches` row per recipient per issue. At a few thousand subscribers this is unremarkable; the bookkeeping is unchanged, just finer.
- A flagged send now strands one person instead of up to 1,000, which makes [ADR 0001](0001-at-most-once-delivery.md)'s at-most-once tradeoff cheaper: resolving a flag by hand affects one inbox.
- Sending is sequential, which is also the rate limit — roughly three per second, inside Mailgun's per-minute allowance. No explicit pacing. Mailgun's rate limit is not the binding constraint, and neither is Cloudflare's 10,000 subrequests: D1 allows 1,000 queries per Worker invocation, and every statement inside a `batch()` counts as one. Claiming and sending one range costs five. Rather than a fixed send cap sized by hand against the other phases, every phase whose cost grows with its input — feed ingest, suppression, the admin alerts, sending — charges the budget before it queries, and yields to the next tick when it cannot afford to: `afford()` for work that needs the whole amount, `spend()` for work that will settle for less; `QUERY_RESERVE` holds back the one-off reads nothing charges for, such as the flagging UPDATE and the scans for open issues and unalerted batches. Exceeding D1's limit throws mid-send and strands a claimed range, so the budget exists to stop short of it, not to pace anything. Sending is charged per claimed range rather than per message, because an emptied retry range costs the same queries while sending nothing, and in two parts, so a pass that finds an issue finished doesn't pay for a send it never makes.
- A long list can outrun the cron wall-clock limit, so a tick stops after `SEND_BUDGET_MS` and the next resumes from the cursor. Without it, every range still in flight when the Worker is killed would be flagged.
- A tick stops sending after `MAX_CONSECUTIVE_FAILURES` refusals in a row. One call per recipient means a provider outage would otherwise log once per subscriber, which is a bill once `console.error` reaches an error tracker.
- The streak is counted per send loop, and hitting it in the retry phase ends that phase rather than the issue. Sharing one count across a tick would let a few permanently rejected addresses stop every issue published afterwards, and ending the issue on it would stop that issue ever reaching a new subscriber. Both were found in review of this change.
- A refusal is cheap — the send is marked `failed` and retried — but a dropped connection is not: its outcome is unknown, so the breaker's five sends become five flagged sends and five admin alerts to resolve by hand. That is a worse aggregate than the one alert per 1,000-recipient batch it replaces, though it is bounded per tick.
- Delivery of a large issue takes several ticks — about an hour per 180-odd subscribers, depending on what the tick's other phases spend — so it is much slower to finish than a batched send, which spends the same five queries on up to 1,000 people. That is the cost of the default working without configuration, and it is why the guidance is to raise `BATCH_SIZE` as soon as the domain allows rather than when the wait becomes painful.
