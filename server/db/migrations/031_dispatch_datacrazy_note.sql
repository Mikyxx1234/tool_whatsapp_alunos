ALTER TABLE activation_dispatch_events
  ADD COLUMN IF NOT EXISTS datacrazy_note_failed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS datacrazy_note_id TEXT;
