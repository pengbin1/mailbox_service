CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  purge_at TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_purge_at ON mailboxes(purge_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  rfc_message_id TEXT,
  envelope_from TEXT NOT NULL,
  header_from TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  UNIQUE (mailbox_id, rfc_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received ON messages(mailbox_id, received_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
