-- Times are Unix milliseconds.

CREATE TABLE subscribers (
  -- AUTOINCREMENT: ids are never reused, which issue cursors rely on.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed')),
  -- Used in both confirm and unsubscribe links.
  token TEXT NOT NULL UNIQUE,
  consent_at INTEGER,
  consent_source TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX subscribers_status_id ON subscribers (status, id);

CREATE TABLE items (
  guid TEXT PRIMARY KEY,
  pub_date INTEGER,
  seen_at INTEGER NOT NULL,
  -- NULL: seeded or stale, never emailed. Content is stored only for issues.
  issued_at INTEGER,
  title TEXT,
  link TEXT,
  html TEXT,
  -- Highest subscriber id claimed by a batch of this issue.
  cursor INTEGER NOT NULL DEFAULT 0,
  -- Set once no active subscriber is left above the cursor; later subscribers never get this issue.
  done_at INTEGER
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT NOT NULL REFERENCES items (guid),
  -- Recipients: active subscribers with after_id < id <= last_id.
  after_id INTEGER NOT NULL,
  last_id INTEGER NOT NULL,
  -- in_flight: handed to Mailgun, outcome unknown. failed: Mailgun refused; retried.
  -- flagged: in flight too long; never retried automatically (docs/adr/0001).
  status TEXT NOT NULL CHECK (status IN ('in_flight', 'sent', 'failed', 'flagged')),
  started_at INTEGER NOT NULL,
  alerted_at INTEGER,
  -- Two overlapping ticks can't both claim the same range.
  UNIQUE (guid, after_id)
);
