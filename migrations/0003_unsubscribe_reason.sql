-- Why someone stopped receiving mail, and when. A bounce and a spam complaint both end sending,
-- but they are not the same event and the difference matters for list hygiene and for answering
-- "did we keep mailing someone who complained?". Status stays 'unsubscribed' for all of them so
-- the sending query is unchanged.
-- Values: 'self' (used the link), 'bounce' (the address is dead), 'complaint' (marked as spam).
ALTER TABLE subscribers ADD COLUMN unsubscribed_at INTEGER;
ALTER TABLE subscribers ADD COLUMN unsubscribe_reason TEXT;
