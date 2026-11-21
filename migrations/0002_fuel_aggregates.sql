-- aisits:no-transaction
-- 0002_fuel_aggregates — hourly and daily fuel sums per vessel (spec §13.4):
-- continuous aggregate fuel_hourly on fuel_readings and the hierarchical
-- fuel_daily on fuel_hourly, bucketed in UTC. A reading counts in the bucket
-- of its "time" (the end of its measured period). Continuous aggregates cannot
-- be created inside a transaction block, hence the marker above (statements
-- run one by one). Real-time aggregation (materialized_only = false) serves
-- the buckets not materialized yet, so the newest readings are always included.

CREATE MATERIALIZED VIEW fuel_hourly
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
  'Hourly fuel sums per vessel (UTC buckets; refreshed every 15 min over the last 35 days, kept 5 years)';

-- Late readings up to 35 days old (devices that stored and forwarded) are
-- re-materialized by the policy; the last hour is served in real time.
SELECT add_continuous_aggregate_policy('fuel_hourly',
  start_offset => INTERVAL '35 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes');

SELECT add_retention_policy('fuel_hourly', drop_after => INTERVAL '5 years');

CREATE MATERIALIZED VIEW fuel_daily
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
  'Daily fuel sums per vessel (UTC days, from fuel_hourly; refreshed hourly over the last 40 days, kept indefinitely)';

SELECT add_continuous_aggregate_policy('fuel_daily',
  start_offset => INTERVAL '40 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');
