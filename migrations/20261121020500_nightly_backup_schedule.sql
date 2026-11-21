-- Runs the nightly backup (hq_nightly.take, see 20261121020452_nightly_backup.sql) every day at 08:00 UTC:
-- 2:00 AM Central in winter, 3:00 AM in summer. pg_cron's clock is GMT on this project.
-- To see the job: select * from cron.job;  its runs: select * from cron.job_run_details order by start_time desc limit 10;
-- To run one by hand: select hq_nightly.take();
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('hq-nightly-backup', '0 8 * * *', $$select hq_nightly.take()$$);
