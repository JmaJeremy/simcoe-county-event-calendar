-- Edits made in the console to events the ingest run builds.
--
-- Dedup rewrites every event in its window from its listings on every run, so an edit
-- written straight into `events` would be gone within two hours. An override is kept
-- here instead and applied on top of whatever the sources say, by dedup and by the
-- console alike. Only the fields actually edited are stored; the rest keep following the
-- sources.
CREATE TABLE IF NOT EXISTS event_overrides (
  -- events.id, which is sticky for the life of a cluster.
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  -- JSON object keyed by Event property names; see applyOverrides in packages/core.
  fields TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The Access identity that made the last edit.
  updated_by TEXT NOT NULL
);
