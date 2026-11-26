-- aisits:no-transaction
-- 0003_device_last_reading — measurement time of each device's newest reading
-- (GET /telemetry/devices: lastReadingAt and the connection state online / idle
-- / offline). The ingestion paths write it together with last_seen_at when one
-- of them advances by more than a minute, never backwards; a column instead of
-- a lookup because fuel_readings has no index on device_id (the newest reading
-- of a device that shares its vessel with another one would mean scanning the
-- vessel's history).
--
-- Statements run one by one (marker above): the column is added in a short
-- transaction of its own, so the backfill holds row locks only (ingestion keeps
-- reading devices meanwhile) instead of the ACCESS EXCLUSIVE lock of ALTER
-- TABLE. Every statement is idempotent (IF NOT EXISTS, only rows still NULL):
-- the migrator records a no-transaction migration only after all of its
-- statements succeeded, so a run that failed halfway converges when retried.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_reading_at timestamptz;

COMMENT ON COLUMN devices.last_reading_at IS
  'Measurement time of the newest reading stored as the device''s (written with last_seen_at, minute resolution)';

-- Backfill from the stored readings: per device that delivered readings
-- (last_seen_at is set after every stored batch of a device), its newest
-- reading on its current vessel, read backwards on the primary key
-- (mmsi, time) of each chunk, newest chunk first, stopping at the first match.
-- A device moved to another vessel after its last reading gets the value with
-- its next reading.
UPDATE devices AS d
SET last_reading_at = (
  SELECT r.time
  FROM fuel_readings AS r
  WHERE r.mmsi = d.mmsi AND r.device_id = d.id
  ORDER BY r.time DESC
  LIMIT 1
)
WHERE d.last_reading_at IS NULL
  AND d.last_seen_at IS NOT NULL;
