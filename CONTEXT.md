# RSS-to-Email

Emails new items from one RSS feed to a list of confirmed subscribers.

## Language

### Feed

**Item**:
One entry in the feed, identified by its GUID.
_Avoid_: Post, entry, article

**Seen item**:
An item whose GUID has been recorded; it is never considered again, whether or not it was emailed.

**Stale item**:
An item whose publication date is more than 7 days old when first seen; it becomes a seen item without being emailed.
_Avoid_: Backfill, old post

### Subscribers

**Subscriber**:
An email address on the list, in exactly one of three states: pending, active, or unsubscribed.
_Avoid_: User, member, contact

**Pending subscriber**:
A subscriber who has asked to join but has not clicked the confirmation link; receives no issues.

**Active subscriber**:
A subscriber who has confirmed consent; the only kind that receives issues.

**Consent**:
The recorded moment and source of a subscriber's confirmation; rewritten each time they confirm.

### Sending

**Issue**:
The sending of one item to the subscriber list.
_Avoid_: Send, campaign, newsletter (for a single send)

**Tick**:
One cron run. Holds a budget — a wall-clock deadline and a share of D1's per-invocation query limit — that every phase whose cost grows with its input draws from; work that doesn't fit waits for the next tick.
_Avoid_: Run, cycle, job

**Claim**:
A range of subscriber IDs a tick has taken for an issue, recorded as an in-flight batch and owed a delivery. Claims come from two places: ranges a previous tick had refused, and the next range past the issue's cursor.
_Avoid_: Chunk, slice, lease

**Batch**:
One provider call delivering an issue to a claimed range of subscribers. `BATCH_SIZE` sets how many, and defaults to 1 — so a batch is normally one recipient, and the range holds one ID.

**Suppressed**:
An address the provider will not deliver to, because it bounced or the recipient reported spam. Mirrored into `subscribers` as `status = 'unsubscribed'` with an `unsubscribe_reason` of `bounce` or `complaint`.
_Avoid_: Blocked, banned. The provider enforces this, not us.

**Flagged batch**:
A batch whose outcome is unknown (the provider may or may not have accepted it); it is never retried automatically and awaits a person.
_Avoid_: Failed batch (a failed batch is known not to have been accepted, and is retried)
