-- Backfill bookkeeping only; the resumable Node script owns conversion and parity.
CREATE TABLE IF NOT EXISTS file_metadata_backfill_runs (
  id text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, dry_run boolean NOT NULL DEFAULT false,
  batch_size integer NOT NULL, status text NOT NULL DEFAULT 'running', report jsonb
);
