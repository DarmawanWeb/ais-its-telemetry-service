# Changelog

All notable changes to `ais-its-telemetry-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The first release is `0.1.0`
(`package.json`): on release, move the entries below under `## [0.1.0] - <date>` and tag `v0.1.0`.

## [Unreleased]

### Added

- Fuel readings ingest `POST /api/v2/telemetry/readings` for API keys (`telemetry:ingest`) and users
  (`telemetry:write`, `?source=manual|import`): one reading or up to 1000, all or nothing, with
  plausibility rules (non-negative, configurable maxima, clock skew ≤ 5 min, age within the 5-year
  retention, measured period) and idempotency by `(mmsi, time)`.
- Tenancy from the `FLEET` projection (`telemetry-fleet` → `telemetry.vessels`, versioned snapshots,
  tombstones, MMSI changes): unknown vessels `404 VESSEL_NOT_FOUND`, other organizations `403`.
- Device registry `/api/v2/telemetry/devices` (`device:manage`): `mqtt` devices with their topic
  `aisits/telemetry/<deviceId>`, `http` devices linked to an API key (readings attributed with source
  `device`), activation, audit events.
- MQTT ingest through the NATS MQTT gateway (core subscription `telemetry-mqtt` on
  `aisits.telemetry.<deviceId>`, queue group `telemetry`): single readings or store-and-forward
  arrays; unknown, inactive, non-MQTT devices and vessels outside the device's organization are
  rejected and counted.
- `fuel_readings` hypertable (compression after 7 days, retention 5 years) with the continuous
  aggregates `fuel_hourly` and hierarchical `fuel_daily` (real time, invalidation-driven refresh
  policies); `GET /telemetry/vessels/:mmsi/readings?bucket=raw|1h|1d` (cursor pages),
  `…/summary` (exact totals from days, hours and raw edges), `…/status` (active within
  `TELEMETRY_ACTIVE_WINDOW_MIN`), `GET /telemetry/vessels` overview.
- Reliable publication of `fuel.reading.recorded.v1` (stream `FUEL`, producer): after the commit with
  `Nats-Msg-Id = <mmsi>:<time>`, `published_at` per reading and a relay
  (`FOR UPDATE SKIP LOCKED` on the `fuel_readings_unpublished` queue) for readings still unpublished
  after `TELEMETRY_RELAY_AFTER_S`.
- Domain metrics `aisits_telemetry_*` (readings, device messages, lag, relay and backlog),
  `GET /api/v2/telemetry/methodology` (`fuel.method_selection`, `telemetry.fuel_reading_usage`).
- Integration tests against TimescaleDB and NATS (incl. a real MQTT client through the NATS MQTT
  gateway), README service handbook, `openapi.json`.

### Changed (from the legacy MVP)

- Telemetry "active" window counted in minutes (`TELEMETRY_ACTIVE_WINDOW_MIN`, default 10); the
  legacy `FuelDataRepository.isActive` divided by 10 000 instead of 60 000 (a 10-second window),
  spec §15.5.
- Readings are immutable and idempotent; the legacy update/delete endpoints have no v2 equivalent
  (see the README, legacy parity notes).

[Unreleased]: https://github.com/DarmawanWeb/ais-its-telemetry-service/commits/main
