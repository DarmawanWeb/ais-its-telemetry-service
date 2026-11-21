-- 0001_init — initial schema of ais-its-telemetry-service (docs/PLATFORM_SPEC.md §6, §13.4).
--
-- Runs inside schema "telemetry" (search_path=telemetry,public) as the role
-- telemetry_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0003_<change>.sql instead.

COMMENT ON SCHEMA telemetry IS 'telemetry service — owned by telemetry_svc';

-- Projection of the FLEET stream (durable consumer telemetry-fleet): which
-- organization owns the vessel behind an MMSI (tenancy, spec §8.5). One row
-- per MMSI; snapshots apply only when newer (source_updated_at), deletions
-- leave a tombstone (deleted_at) so that late, older snapshots stay ignored.
CREATE TABLE vessels (
  mmsi              integer PRIMARY KEY CHECK (mmsi BETWEEN 100000000 AND 999999999),
  vessel_id         uuid NOT NULL,
  org_id            uuid,
  name              text NOT NULL,
  status            text NOT NULL CHECK (status IN ('active', 'inactive', 'laid_up')),
  source_updated_at timestamptz NOT NULL,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vessels_vessel_id_key UNIQUE (vessel_id)
);

CREATE INDEX vessels_org_idx ON vessels (org_id, mmsi) WHERE deleted_at IS NULL;

COMMENT ON TABLE vessels IS
  'Projection of FLEET (telemetry-fleet): MMSI -> vessel and owning organization';

-- Fuel meters and gateways of an organization, installed on one vessel.
-- kind = 'mqtt': publishes to MQTT topic aisits/telemetry/<id>;
-- kind = 'http': posts to POST /api/v2/telemetry/readings with the API key
-- api_key_id (readings of that key are attributed to the device).
CREATE TABLE devices (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  mmsi          integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind          text NOT NULL CHECK (kind IN ('mqtt', 'http')),
  api_key_id    uuid,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  serial_number text CHECK (char_length(serial_number) BETWEEN 1 AND 120),
  last_seen_at  timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_kind_api_key_check CHECK ((kind = 'http') = (api_key_id IS NOT NULL)),
  CONSTRAINT devices_org_name_key UNIQUE (org_id, name),
  CONSTRAINT devices_org_api_key_key UNIQUE (org_id, api_key_id)
);

CREATE INDEX devices_org_mmsi_idx ON devices (org_id, mmsi);

COMMENT ON TABLE devices IS 'Telemetry devices (fuel meters) of an organization, one vessel each';

-- Fuel consumption readings: tonnes of fuel burnt by the main (ME) and
-- auxiliary (AE) engines in the period ending at "time" (since period_start
-- when given). Idempotent by (mmsi, time). published_at stays NULL until the
-- reading is stored in the FUEL stream (fuel.reading.recorded.v1).
CREATE TABLE fuel_readings (
  time         timestamptz NOT NULL,
  mmsi         integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  device_id    uuid,
  period_start timestamptz,
  fuel_me_ton  double precision NOT NULL CHECK (fuel_me_ton >= 0),
  fuel_ae_ton  double precision NOT NULL CHECK (fuel_ae_ton >= 0),
  source       text NOT NULL CHECK (source IN ('device', 'mqtt', 'api', 'manual', 'import')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT fuel_readings_pkey PRIMARY KEY (mmsi, time),
  CONSTRAINT fuel_readings_period_check CHECK (period_start IS NULL OR period_start < time)
);

SELECT create_hypertable('fuel_readings', by_range('time', INTERVAL '7 days'));

ALTER TABLE fuel_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('fuel_readings', compress_after => INTERVAL '7 days');
SELECT add_retention_policy('fuel_readings', drop_after => INTERVAL '5 years');

COMMENT ON TABLE fuel_readings IS
  'Fuel readings (hypertable, 7-day chunks, compressed after 7 days, kept 5 years)';

-- Readings whose publication is pending: one row per fuel_readings row with
-- published_at IS NULL, written in the same transaction as the reading and
-- removed in the same transaction that sets published_at. The relay locks
-- these rows (FOR UPDATE SKIP LOCKED) instead of scanning the hypertable,
-- whose compressed chunks cannot be searched for NULLs cheaply.
CREATE TABLE fuel_readings_unpublished (
  mmsi        integer NOT NULL,
  time        timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fuel_readings_unpublished_pkey PRIMARY KEY (mmsi, time)
);

CREATE INDEX fuel_readings_unpublished_received_idx ON fuel_readings_unpublished (received_at);

COMMENT ON TABLE fuel_readings_unpublished IS
  'Readings not yet in the FUEL stream (work queue of the publication relay)';
