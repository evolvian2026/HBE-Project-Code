-- Run after the EC2 cutover (DEPLOYMENT.md §3, step 4).
select cron.unschedule('hbe-keep-awake');
