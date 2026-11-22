# Changelog

All notable changes to `ais-its-telemetry-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-22

### Added

- Fuel readings ingest `POST /api/v2/telemetry/readings` for API keys (`telemetry:ingest`) and users
  (`telemetry:write`, `?source=manual|import`): one reading or up to 1000, all or nothing, with
  plausibility rules (non-negative, configurable maxima, clock skew ≤ 5 min, age within the 5-year
  retention, measured period).
- One reading per vessel and time, immutable: an exact repeat (same period, amounts and device) is an
  idempotent duplicate; a different reading at a stored `(mmsi, time)` — other values, or another
  device of the vessel reporting the same instant — is never stored and never dropped silently:
  `409 READING_CONFLICT` on REST (with `<index>.time` errors, nothing stored), outcome `conflict` on
  MQTT (the device's other readings are stored), `aisits_telemetry_readings_total{outcome="conflict"}`.
  Two different readings of one key in the same request are `400 VALIDATION_FAILED`
  (`conflicting_repeat`).
- Tenancy from the `FLEET` projection (`telemetry-fleet` → `telemetry.vessels`, versioned snapshots,
  tombstones, MMSI changes): unknown vessels `404 VESSEL_NOT_FOUND`, other organizations `403`.
- Device registry `/api/v2/telemetry/devices` (`device:manage`): `mqtt` devices with their topic
  `aisits/telemetry/<deviceId>`, `http` devices linked to an API key (readings attributed with source
  `device`), activation, audit events. `PATCH` refuses `null` for `mmsi`, `name`, `kind` and `status`
  (`400`); a kind/API-key pair broken by a concurrent change is `409 DEVICE_CREDENTIAL_CONFLICT`.
- MQTT ingest through the NATS MQTT gateway (core subscription `telemetry-mqtt` on
  `aisits.telemetry.<deviceId>`, queue group `telemetry`): single readings or store-and-forward
  arrays; unknown, inactive, non-MQTT devices and vessels outside the device's organization are
  rejected and counted.
- `fuel_readings` hypertable (compression after 7 days, retention 5 years) with the continuous
  aggregates `fuel_hourly` and hierarchical `fuel_daily` (real time, invalidation-driven refresh
  policies; migration `0002` is idempotent, so a deployment that failed halfway converges on retry);
  `GET /telemetry/vessels/:mmsi/readings?bucket=raw|1h|1d` (cursor pages), `…/summary` (exact totals
  from days, hours and raw edges, sums rounded to 1 mg), `…/status` (active within
  `TELEMETRY_ACTIVE_WINDOW_MIN`), `GET /telemetry/vessels` overview.
- Each UTC day of a batch is stored in its own transaction, and marking readings as published logs no
  aggregate invalidation (`published_at` feeds no aggregate): a request invalidates only the days it
  holds readings for, so a late or historical reading never forces a re-aggregation of the time in
  between for the whole fleet.
- Reliable publication of `fuel.reading.recorded.v1` (stream `FUEL`, producer): after the commit with
  `Nats-Msg-Id = <mmsi>:<time>`, `published_at` per reading and a relay
  (`FOR UPDATE SKIP LOCKED` on the `fuel_readings_unpublished` queue) for readings still unpublished
  after `TELEMETRY_RELAY_AFTER_S`. Statements on stored keys name their MMSIs (`segmentby`) and one
  day's time range, so marking a reading of a compressed chunk decompresses only that vessel's batch.
- While NATS stalls, an ingest request waits at most `TELEMETRY_PUBLISH_TIMEOUT_MS` after the commit:
  the audit records of user entries are published concurrently with the readings under the same
  deadline.
- Domain metrics `aisits_telemetry_*` (readings, device messages, lag, relay and backlog),
  `GET /api/v2/telemetry/methodology` (`fuel.method_selection`, `telemetry.fuel_reading_usage`).
- Integration tests against TimescaleDB and NATS (incl. a real MQTT client through the NATS MQTT
  gateway, two devices on one vessel, a stalled NATS server, compressed multi-vessel chunks, the
  aggregate invalidation log and a retried migration), README service handbook, `openapi.json`.

### Changed (from the legacy MVP)

- Telemetry "active" window counted in minutes (`TELEMETRY_ACTIVE_WINDOW_MIN`, default 10); the
  legacy `FuelDataRepository.isActive` divided by 10 000 instead of 60 000 (a 10-second window),
  spec §15.5.
- Readings are immutable and idempotent; the legacy update/delete endpoints have no v2 equivalent
  (see the README, legacy parity notes).

[Unreleased]: https://github.com/DarmawanWeb/ais-its-telemetry-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-telemetry-service/releases/tag/v0.1.0
