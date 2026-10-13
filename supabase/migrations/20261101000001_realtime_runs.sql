-- ============================================================================
-- Live run status (docs/ARCHITECTURE.md §11): pages showing test runs subscribe to changes of
-- the runs, and Realtime sends each subscriber only the rows (and columns) they may read, under
-- the same RLS policy and column grants as a query.
-- ============================================================================
alter publication supabase_realtime add table public.evaluation_runs;
