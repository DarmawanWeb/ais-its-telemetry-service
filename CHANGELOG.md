# Changelog

All notable changes to `ais-its-telemetry-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-22

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0: the
local workarounds for the platform issues this service reported are gone (stream re-creation,
MQTT test infrastructure, the widened fleet envelope), template helpers replace local ones, and
the backend gaps the web app reported are closed. One migration, `0003_device_last_reading` (a
nullable column, backfilled with row locks only; 0.1.0 replicas tolerate it and log that a recorded
migration has no file); 0.1.0 and 0.2.0 replicas can run side by side during a rolling update (same
tables, subjects, queue group and durable; readings a 0.1.0 replica stores do not advance a device's
`lastReadingAt` until its next reading on 0.2.0), but only 0.2.0 answers the new API: a 0.1.0
replica answers every request with `order` (`order=asc` included) with `400 VALIDATION_FAILED`
(`field: 'order'`), `readings.csv`, `/vessels/:mmsi/devices` and `/devices/:id/connection` with
`404 NOT_FOUND`, and devices without `vesselName`, `lastReadingAt` and `connectionState`. Switch the
web app to `order=desc`, the CSV export, the devices list, the device connection state and the
connection guide only once every telemetry replica runs 0.2.0.

### Added

- `order=asc|desc` on `GET /api/v2/telemetry/vessels/:mmsi/readings` (all buckets): `desc` pages
  newest first, e.g. the newest readings with `order=desc&limit=20`, and its cursor continues
  backwards. A cursor carries its order: one of the other order (or bucket) is
  `400 VALIDATION_FAILED` (`field: 'cursor'`); cursors issued by 0.1.0 continue ascending.
- `GET /api/v2/telemetry/vessels/:mmsi/readings.csv?from&to&bucket` (`telemetry:read`): the series
  as one streamed RFC 4180 file (`text/csv; charset=utf-8; header=present`,
  `Content-Disposition: attachment; filename="telemetry-<mmsi>-<bucket>-<from>_<to>.csv"`), with the
  defaults and range limits of the series (raw ≤ 31 d, `1h` ≤ 366 d, `1d` ≤ 5 y), the columns of the
  web app's export (`time,periodStart,fuelMeTon,fuelAeTon,totalFuelTon,readings,source,deviceId`)
  and the values of the JSON points. Read in keyset batches of 5 000 points as the client consumes
  them; tenancy, permissions, range and the first batch are checked before the first byte (problem
  details), a failure during the transfer aborts the connection (never a cut file that looks
  complete). `Content-Disposition` is exposed cross-origin.
- `GET /api/v2/telemetry/vessels/:mmsi/devices?page&pageSize` (`telemetry:read`): the devices the
  vessel's organization registered on it, by name, read-only (`id`, `name`, `kind`, `status`,
  `lastSeenAt`; no API key, serial number, MQTT topic or creator), so fleet managers see which
  meters report without `device:manage`; the same devices `GET /telemetry/vessels` counts.
- Devices of `GET /api/v2/telemetry/devices` (and `GET …/:id`, the `POST`/`PATCH` responses) carry
  `vesselName` (FLEET projection, joined by primary key, so names no longer depend on the web app
  joining `GET /vessels` page by page; `null` while the MMSI is not a live vessel), `lastReadingAt`
  (measurement time of the newest reading stored as the device's on its current vessel: new or an
  exact repeat, never a refused conflict; a move to another vessel clears it, so an online device
  always means active telemetry of its vessel) and `connectionState` — `inactive` (switched off),
  `never` (no reading on its current vessel yet), `online` (newest reading at most
  `activeWindowMin` old: the vessel telemetry "active" rule, `fuel.method_selection`), `idle` (up
  to `offlineAfterMin`), `offline` — with both thresholds in every item (`activeWindowMin` =
  `TELEMETRY_ACTIVE_WINDOW_MIN`, `offlineAfterMin` = the new `TELEMETRY_DEVICE_OFFLINE_AFTER_MIN`,
  default 1440 = 24 h, at least the active window), replacing the web app's fixed client thresholds
  (15 min / 24 h on `lastSeenAt`).
- `devices.last_reading_at` (migration `0003_device_last_reading`, no-transaction and idempotent:
  `ADD COLUMN IF NOT EXISTS`, backfill of rows still `NULL` from each device's newest reading on its
  current vessel, read backwards on the `(mmsi, time)` primary key). Both ingestion paths write it
  with `last_seen_at` in one statement, when either advances by more than a minute (about once a
  minute for a device reporting in real time), never backwards (`GREATEST`), and only while the
  device is still on the vessel the batch was stored on; `PATCH /devices/:id` with another `mmsi`
  clears it in the same statement as the move (`last_seen_at` is kept).
- `GET /api/v2/telemetry/devices/:id/connection` (`device:manage`, tenant-private like the device):
  how an `mqtt` device connects and publishes — `brokerUrl`, `host`, `port`, `tls` from the new
  `TELEMETRY_MQTT_URL` (`mqtt://host[:port]` default port 1883, `mqtts://` TLS default 8883; no
  credentials, path or port 0 accepted, the host ASCII — an internationalized name in punycode, as
  `mqtt:` URLs get no IDNA processing; default `mqtt://localhost:1883`, the development broker, with
  a startup warning in production), `protocolVersion` `3.1.1` (the NATS MQTT gateway), the device's
  `topic`, `qos` 1, and `authentication` / `username` from the new `TELEMETRY_MQTT_AUTH` (`none`:
  any client, `username` `null`; `password`, the production default: the device's own broker user,
  named by its id). `http` devices answer `409 DEVICE_NOT_MQTT`. No password is issued, stored or
  returned (requested with the connection details, not implemented): the broker authenticates MQTT
  clients against its own users, not against this service, so a password generated here would not be
  checked (the development broker accepts any client); making the service the authenticator (a NATS
  auth callout) would put it in the broker's connect path with the account signing key — a platform
  decision (spec §3, §7.3, `infra/nats`) — and machine credentials are the auth service's domain
  (spec §8.1, §13.1). The platform operator provisions each device's broker user and password
  (README, _MQTT connection of a device_).
- Methodology: `telemetry.reading_validation` (catalogued in contracts 0.4.0) tagged on
  `readingViolations`, `batchViolations`, `repeatViolations` and `compareWithStored` and listed in
  `IMPLEMENTED_METHOD_IDS`, so `GET /telemetry/methodology` describes all three methods.
- Integration tests: a `FUEL` stream deleted at runtime is re-created by the next publish; readings
  stay queued while a sealed `FUEL` stream rejects them and are relayed once it is replaced; the MQTT
  round trip on the kit's MQTT-enabled test NATS, also with exactly the details of
  `GET /devices/:id/connection`; newest-first pages; the CSV export (values, buckets, empty range,
  headers, CORS, problem details); the devices of a vessel (tenancy, permissions, no credentials);
  vessel names, `lastReadingAt` on both ingestion paths and every `connectionState`, a reporting
  device moved to another vessel (`never` there; a batch of its previous vessel in flight refreshes
  only `lastSeenAt`); the connection endpoint (`409`, `404`, `403`, `400`); the `0003` backfill
  retried without overwriting values; path parameter errors; the catalogued methodology; the manual
  aggregate refresh of the tests (`test/support/aggregates.ts`) pauses the refresh policies and
  waits out a run in progress (kit `refreshContinuousAggregate`) instead of failing with `55P03`
  ("due to a concurrent refresh", a policy run overlapping it), against a refresh window registered
  in the TimescaleDB catalog.

### Changed

- Dependencies: contracts `^0.4.0`, kit `^0.3.0`; `prom-client` removed (the metric types come from
  `@darmawanweb/ais-its-nest/metrics`); `.pnpmfile.cjs` keeps the `@nestjs/terminus` optional gRPC
  peers out of the production install (template hook), so the image holds no `testcontainers`,
  `dockerode`, `ssh2`, `@grpc/grpc-js`, `protobufjs` or `@opentelemetry/sdk-node`.
- Path parameters are parsed from the raw path segment by the kit's `@MmsiParam()` and
  `@UuidParam()`. `:mmsi` must be exactly nine digits forming an MMSI: the segments that 0.1.0's
  global `ValidationPipe` coerced with `+value` before the MMSI check (`0525005223`,
  `525005223.0`, `%20525005223`, `5.25005223e8`, and `0x…`, which resolved to another MMSI:
  `0x1F4A1D67` read vessel 524950887) now answer `400 VALIDATION_FAILED`
  (`{ field: 'mmsi', code: 'isMmsi' }`). A malformed device id answers `400 VALIDATION_FAILED` with
  `{ field: 'id', code: 'isUuid' }` (was the bare `400` of `ParseUUIDPipe`). `openapi.json`
  documents both parameter schemas, the page maximum (1 000 000), the security schemes and the new
  routes.
- A `FUEL` stream deleted at runtime is re-created by the next publish (kit `EventPublisher`),
  without a restart; before, every publish failed with "no responders" until the service restarted.
- The service's own logs of database errors (publisher, relay, CSV export) are sanitized with the
  kit's `sanitizeError` (no bound values); the kit sanitizes problem details and its own logs.
- The ingestion pipeline reports the measurement time of the newest reading it holds for a batch
  (`latest`; duplicates count, conflicts do not), which `markSeen` writes as `lastReadingAt`.
- `DeviceDto.lastSeenAt` is documented as the receipt time (it always was); `lastReadingAt` is the
  measurement time.
- Kit 0.3 behaviour: a startup warning when the NATS `max_payload` is below 4 MiB and in production
  while `TRUSTED_PROXIES` is the default (`.env.example` documents both); tracing exports traces
  only; CORS exposes `ETag` and `Location`; database errors in problem details carry the driver's
  primary message only.
- Migrations are found through `MIGRATIONS_DIR` (resolved from the package, not the working
  directory) by the service and `pnpm migrate`.

### Removed

- `src/db/errors.ts` (`pgErrorOf`, `isUniqueViolation`, the SQLSTATE constants) → the kit's
  `databaseErrorInfo`, `isUniqueViolation` and `PG_SQLSTATES`.
- `ParseMmsiPipe` and the MMSI bounds of `src/common/validation.ts` → kit `@MmsiParam()`,
  contracts `MMSI_MIN` / `MMSI_MAX`; the `IfPresent` helpers of `update-device.dto.ts` → kit
  `@IsOptionalNotNull()` (`null` for `mmsi`, `name`, `kind`, `status` still answers `400`).
- The `event.type` narrowing of `src/consumers/fleet.consumer.ts`: `ConsumerEnvelope<'telemetry-fleet'>`
  is exact, the switch is exhaustive.
- The local `asDate` / `asNullableDate` of raw rows → kit `rowDate` / `rowDateOrNull`.
- Test workarounds: the fresh `StreamManager` of `test/relay.int.test.ts` (the publisher re-creates
  the stream; the cleanup uses `streams.ensure(['FUEL'], 'producer', { refresh: true })`) and the
  hand-started `nats:2.11-alpine` MQTT container of `test/mqtt-gateway.int.test.ts`
  (`testInfraGlobalSetup({ postgres: true, nats: { mqtt: true } })`, `testInfra('nats').nats.mqttUrl`).

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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-telemetry-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-telemetry-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-telemetry-service/releases/tag/v0.1.0
