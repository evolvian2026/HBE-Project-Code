-- FREE-TIER DEMO ONLY: stops the Render free service from sleeping (DEPLOYMENT.md §1.2).
-- Run once in the Supabase SQL editor. Remove it when moving to EC2 (remove-keep-awake.sql).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'hbe-keep-awake',
  '*/10 * * * *',
  $$ select net.http_get('https://api.example.com/healthz') $$
);
