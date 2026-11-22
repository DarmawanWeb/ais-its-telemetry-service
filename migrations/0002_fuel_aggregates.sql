-- aisits:no-transaction
-- 0002_fuel_aggregates — hourly and daily fuel sums per vessel (spec §13.4):
-- continuous aggregate fuel_hourly on fuel_readings and the hierarchical
-- fuel_daily on fuel_hourly, bucketed in UTC. A reading counts in the bucket
-- of its "time" (the end of its measured period). Continuous aggregates cannot
-- be created inside a transaction block, hence the marker above (statements
-- run one by one). Real-time aggregation (materialized_only = false) serves
-- the buckets not materialized yet, so the newest readings are always included.
--
-- Every statement is idempotent (IF NOT EXISTS, if_not_exists => true): the
-- migrator records a no-transaction migration only after all its statements
-- succeeded, so a run that failed halfway (connection drop, timeout, restart)
-- converges when it is retried instead of failing on "already exists".

CREATE MATERIALIZED VIEW IF NOT EXISTS fuel_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  mmsi,
  sum(fuel_me_ton) AS fuel_me_ton,
  sum(fuel_ae_ton) AS fuel_ae_ton,
  count(*)         AS readings,
  min(time)        AS first_time,
  max(time)        AS last_time
FROM fuel_readings
GROUP BY 1, 2
WITH NO DATA;

COMMENT ON VIEW fuel_hourly IS
  'Hourly fuel sums per vessel (UTC buckets; refreshed every 15 min, kept 5 years)';

-- The refresh window has no start (start_offset NULL): a refresh only
-- re-materializes the buckets of the invalidation log, so late readings of
-- any age (devices that stored and forwarded, imports of historical data)
-- are folded in at the next run instead of being left out of a fixed
-- window. TimescaleDB logs one [min, max] range per transaction and chunk;
-- the service stores each UTC day of a request in its own transaction, so a
-- request invalidates the days it holds readings for, not the time between
-- them. Buckets of the last hour are served in real time.
SELECT add_continuous_aggregate_policy('fuel_hourly',
  start_offset => NULL,
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => true);

SELECT add_retention_policy('fuel_hourly',
  drop_after => INTERVAL '5 years',
  if_not_exists => true);

CREATE MATERIALIZED VIEW IF NOT EXISTS fuel_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', bucket) AS bucket,
  mmsi,
  sum(fuel_me_ton) AS fuel_me_ton,
  sum(fuel_ae_ton) AS fuel_ae_ton,
  sum(readings)    AS readings,
  min(first_time)  AS first_time,
  max(last_time)   AS last_time
FROM fuel_hourly
GROUP BY 1, 2
WITH NO DATA;

COMMENT ON VIEW fuel_daily IS
  'Daily fuel sums per vessel (UTC days, from fuel_hourly; refreshed hourly, kept indefinitely)';

-- Refreshes of fuel_hourly invalidate the affected days of fuel_daily
-- (hierarchical aggregate), which this policy then re-materializes.
SELECT add_continuous_aggregate_policy('fuel_daily',
  start_offset => NULL,
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true);
