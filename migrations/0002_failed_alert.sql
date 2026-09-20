-- One admin alert per batch Mailgun refuses, however many times it is retried.
ALTER TABLE batches ADD COLUMN failed_alerted_at INTEGER;
