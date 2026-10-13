-- ============================================================================
-- Reconciling with GitHub (docs/ARCHITECTURE.md §5.3): webhook deliveries that failed are asked
-- for again, and each active repository's event feed is read (cheaply: only when it changed,
-- by ETag) for pushes the platform never heard of, with GitHub's time of the push.
-- ============================================================================
alter table public.repositories
  add column events_etag text check (length(events_etag) <= 200),
  add column events_checked_at timestamptz;
