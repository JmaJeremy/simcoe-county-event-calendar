-- The account database's first migration. This directory owns scec-accounts and nothing
-- else; apps/ingest/migrations/ continues to own scec. The split exists for blast radius:
-- the ingest worker parses hostile HTML from 40 third-party sites and never binds this
-- database, so nothing a scraper meets can reach a password hash. See docs/user-accounts.md.
--
-- Auth tables only. Later build-order steps (pins, calendars, digests) bring their own
-- migrations, as scec's did.

-- One row per person. Identity only — what someone owns lives in later tables, so that
-- deletion is a bounded set of statements. The email is stored lowercased and unique;
-- verified_at is what gates every use of a password account, because an unverified account
-- must not exist as a thing a later Google sign-in could be linked to (the takeover rule
-- in docs/user-accounts.md).
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  display_name      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One row per password account. The encoded string carries its own parameters
-- (pbkdf2$sha256$<iterations>$<salt>$<hash>) so the iteration count can rise later without
-- invalidating stored hashes: verify with what the record names, re-hash on a successful
-- sign-in below the floor.
CREATE TABLE user_passwords (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encoded    TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

-- One row per external identity (step 3: Google). Created now, empty, because its shape is
-- what the users table's verification rule defends: an identity links to a user on a
-- verified address or not at all.
CREATE TABLE user_identities (
  provider  TEXT NOT NULL,
  subject   TEXT NOT NULL,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user ON user_identities(user_id);

-- Sessions are opaque 256-bit tokens stored as their SHA-256 hash — never the token
-- itself, so a dump of this table signs nobody in. Stateful on purpose: revocation and
-- "sign out everywhere" must actually work, which a stateless signed cookie cannot do.
-- last_seen_at rolls the expiry; expires_at is the absolute cap.
CREATE TABLE user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);

-- Email-verification and password-reset tokens: hashed at rest like sessions, single use
-- (used_at), short TTL (expires_at). One table with a purpose column rather than two
-- tables with one column of difference.
CREATE TABLE user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX user_tokens_user ON user_tokens(user_id);

-- The rate limiter's memory, on the suggestion form's pattern: a day-salted hash of the
-- caller's IP, plus the account being tried, so the limit works per IP AND per account —
-- per-IP alone does nothing against a distributed attempt on one address, per-account
-- alone lets one host walk a list. account_key is the lowercased email being attempted,
-- which may belong to no user at all; rows expire by created_at and carry nothing worth
-- keeping.
CREATE TABLE auth_attempts (
  ip_hash     TEXT NOT NULL,
  account_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX auth_attempts_ip ON auth_attempts(ip_hash, created_at);
CREATE INDEX auth_attempts_account ON auth_attempts(account_key, created_at);
