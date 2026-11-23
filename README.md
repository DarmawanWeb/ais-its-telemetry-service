# ais-its-telemetry-service

Fuel consumption telemetry of **AIS Maritime Intelligence** v2: fuel readings of the main (ME) and
auxiliary (AE) engines arrive from fuel meters (MQTT through the NATS MQTT gateway, or HTTP with an
API key), partner systems and manual entry; the service validates them, enforces tenancy, stores them
in a TimescaleDB hypertable, serves raw and bucketed queries, summaries and the "telemetry active"
status, keeps a device registry, and is the producer of the `FUEL` stream
(`fuel.reading.recorded.v1`, consumed by the emission service for the CII).

Service `telemetry` (schema `telemetry`, port **3005**, image
`ghcr.io/darmawanweb/ais-its-telemetry-service`). NestJS 12 + Fastify on the platform kit
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest)
0.3 and the contracts [`@darmawanweb/ais-its-contracts`](https://github.com/DarmawanWeb/ais-its-contracts)
0.4.
The normative engineering spec is [`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) §13.4 in the
central repository ([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose and responsibilities

The service **owns**:

- **Fuel readings** — `fuel_readings` hypertable (PK `(mmsi, time)`: one immutable reading per vessel
  and instant, exact repeats idempotent, different ones refused as conflicts), with hourly and daily
  continuous aggregates for bucketed queries and summaries.
- **Reliable publication** of every stored reading as `fuel.reading.recorded.v1` on
  `fuel.reading.v1.<mmsi>` (stream `FUEL`, created/widened at boot as its producer): published after
  the commit with `Nats-Msg-Id = <mmsi>:<time>`, and republished by a relay when that failed.
- **Device registry** — fuel meters and gateways of an organization, each installed on one vessel;
  `mqtt` devices publish to their own MQTT topic, `http` devices post with their own API key.
- **Telemetry status** — whether a vessel's telemetry is "active" (newest reading within
  `TELEMETRY_ACTIVE_WINDOW_MIN`, default 10 min; the emission service prefers telemetry fuel while it
  is active).
- **Tenancy of telemetry** (spec §8.5, tenant-private) from its own projection of the `FLEET` stream
  (`telemetry.vessels`: MMSI → vessel → organization). The organization is never taken from the client.

It does **not**: compute fuel from AIS (emission does), store vessel master data (fleet), manage API
keys (auth issues them; this service introspects them through the kit), or run the MQTT broker (the
NATS server's MQTT gateway does, spec §3).

## Architecture

```mermaid
flowchart LR
  subgraph clients[Producers of readings]
    meter[Fuel meter<br/>MQTT client]
    gw[HTTP gateway / partner<br/>X-API-Key telemetry:ingest]
    user[User<br/>JWT telemetry:write]
  end
  subgraph nats[NATS]
    mqtt[MQTT gateway :1883<br/>topic aisits/telemetry/&lt;deviceId&gt;]
    core((core subject<br/>aisits.telemetry.&lt;deviceId&gt;))
    fleet[(stream FLEET<br/>fleet.vessel.v1.&gt;)]
    fuel[(stream FUEL<br/>fuel.reading.v1.&lt;mmsi&gt;)]
    audit[(stream AUDIT<br/>audit.v1.telemetry)]
  end
  subgraph svc[telemetry :3005]
    rest[ReadingsController<br/>DevicesController]
    dev[DeviceMessagesConsumer<br/>queue group telemetry]
    fc[FleetConsumer<br/>durable telemetry-fleet]
    ingest[ReadingIngestService<br/>validate · tenancy · dedupe]
    pub[ReadingPublisher<br/>after commit]
    relay[ReadingRelay<br/>every 5 s, rows &gt; 30 s]
  end
  subgraph pg[PostgreSQL schema telemetry]
    readings[(fuel_readings<br/>hypertable)]
    queue[(fuel_readings_unpublished)]
    caggs[(fuel_hourly → fuel_daily<br/>continuous aggregates)]
    vessels[(vessels<br/>FLEET projection)]
    devices[(devices)]
  end
  meter --> mqtt --> core --> dev --> ingest
  gw --> rest
  user --> rest --> ingest
  ingest -- one transaction --> readings & queue
  ingest --> pub -- Nats-Msg-Id mmsi:time --> fuel
  relay -- FOR UPDATE SKIP LOCKED --> queue
  relay --> fuel
  readings --> caggs
  fleet --> fc --> vessels
  rest -. device changes, manual readings .-> audit
  fuel --> emission[emission-fuel<br/>emission service]
```

Ingestion pipeline (shared by REST and MQTT):

```mermaid
sequenceDiagram
  participant C as Client / device
  participant S as telemetry
  participant DB as PostgreSQL
  participant JS as JetStream (FUEL)
  C->>S: readings (≤ 1000)
  S->>S: validate (≥ 0, maxima, skew ≤ 5 min, age ≤ 5 y, period)
  S->>DB: vessels of the MMSIs (FLEET projection) → org must match the principal / device
  loop each UTC day of the batch (one transaction each)
    S->>DB: INSERT … ON CONFLICT (mmsi, time) DO NOTHING · compare skipped keys with the stored rows · queue new rows · COMMIT
  end
  Note over S,DB: a different reading at a stored key → REST: rollback, 409 READING_CONFLICT · MQTT: left out, outcome conflict
  par publication
    S->>JS: publish fuel.reading.recorded.v1 (Nats-Msg-Id <mmsi>:<time>)
    JS-->>S: ack
    S->>DB: published_at = now(), dequeue (no aggregate invalidation)
  and audit (users)
    S->>JS: audit.recorded.v1 per vessel
  end
  S-->>C: 202 { received, accepted, duplicates, published } (≤ TELEMETRY_PUBLISH_TIMEOUT_MS after the commit)
  Note over S,JS: publish failed or the process died → row stays queued with published_at NULL;<br/>the relay republishes it after TELEMETRY_RELAY_AFTER_S (same Nats-Msg-Id)
```

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
start the FLEET consumer, the MQTT core subscription and the relay (`onApplicationBootstrap`) → the
HTTP port opens. Nothing connects in constructors, so `pnpm openapi` runs without infrastructure. On
`SIGTERM` readiness turns `503`, the consumer and the core subscription drain, the relay finishes its
tick, NATS drains and the pool closes.

| Path                                   | What                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/main.ts` / `src/server.ts`        | tracing first, then `bootstrapService()`                                                                      |
| `src/app.module.ts`                    | database, NATS (`FUEL` producer), auth (API keys on `@AllowApiKey` routes), audit, feature modules            |
| `src/config.ts`                        | zod environment schema (kit base + `TELEMETRY_*`)                                                             |
| `src/domain/`                          | pure rules: reading plausibility and dedup, bucket/summary planning and totals, the "active" rule (`@method`) |
| `src/modules/readings/`                | REST ingest, queries and the CSV export, the shared ingestion pipeline, MQTT parsing, publisher, relay        |
| `src/modules/devices/`                 | device registry (controller → service → repository, DTOs) and the read-only devices of a vessel               |
| `src/modules/vessels/`                 | FLEET projection repository and the tenancy rules built on it                                                 |
| `src/modules/methodology/`             | `GET /api/v2/telemetry/methodology` (spec §17)                                                                |
| `src/consumers/`                       | `telemetry-fleet` durable consumer, `telemetry-mqtt` core subscription                                        |
| `src/db/schema.ts`, `migrations/*.sql` | drizzle mirror of the forward-only SQL migrations                                                             |
| `test/*.int.test.ts`                   | integration tests against TimescaleDB and NATS containers                                                     |

## Data model

Schema `telemetry`, owned by `telemetry_svc`; migrations in [`migrations/`](migrations) are
forward-only and checksummed (never edit an applied file — add `NNNN_<change>.sql`).

| Table / view                                         | Columns (essentials)                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fuel_readings` (hypertable on `time`, 7-day chunks) | `time`, `mmsi`, `device_id`, `period_start`, `fuel_me_ton`, `fuel_ae_ton` (≥ 0, t), `source` (`device`\|`mqtt`\|`api`\|`manual`\|`import`), `received_at`, `published_at` | PK `(mmsi, time)`: one immutable reading per vessel and instant (exact repeats are duplicates, different readings conflicts — never overwritten). `time` is the end of the measured period (since `period_start` when given). Compressed after 7 days (`segmentby mmsi`, `orderby time DESC`), retention 5 years. `published_at` is `NULL` until the reading is in `FUEL`. |
| `fuel_readings_unpublished`                          | `mmsi`, `time`, `received_at`                                                                                                                                             | Work queue of the relay: one row per reading with `published_at IS NULL`, written and removed in the same transactions as the reading / its `published_at`, locked with `FOR UPDATE SKIP LOCKED` (replicas share the backlog).                                                                                                                                             |
| `fuel_hourly` (continuous aggregate)                 | `bucket` (UTC hour), `mmsi`, `fuel_me_ton`, `fuel_ae_ton`, `readings`, `first_time`, `last_time`                                                                          | Real-time aggregation; refresh policy every 15 min up to `now − 1 h`, refresh window without a start (invalidation-driven, so late readings and imports of any age are folded in; each UTC day of a request is its own transaction, so only those days are re-aggregated). Retention 5 years.                                                                              |
| `fuel_daily` (hierarchical, on `fuel_hourly`)        | same columns per UTC day                                                                                                                                                  | Real-time; refresh policy hourly up to `now − 1 day`, window without a start. Kept indefinitely.                                                                                                                                                                                                                                                                           |
| `vessels` (FLEET projection)                         | `mmsi` PK, `vessel_id` unique, `org_id`, `name`, `status`, `source_updated_at`, `deleted_at`                                                                              | Snapshots apply only when newer (`updatedAt`); deletions leave a tombstone so late, older snapshots stay ignored; an MMSI change moves the row.                                                                                                                                                                                                                            |
| `devices`                                            | `id`, `org_id`, `mmsi`, `name`, `kind` (`mqtt`\|`http`), `api_key_id`, `status` (`active`\|`inactive`), `serial_number`, `last_seen_at`, `created_by`                     | `org_id` is the organization of the vessel at registration. `http` devices need `api_key_id`, `mqtt` devices have none (`CHECK`). Unique `(org_id, name)` and `(org_id, api_key_id)`. `last_seen_at` is updated at most once a minute. A vessel may have several devices, but one reading per instant (see the ingestion rules).                                           |

Bucketed queries read the continuous aggregates; summaries combine whole UTC days from
`fuel_daily`, whole hours from `fuel_hourly` and the unaligned edges from `fuel_readings`, so the
total over any range equals the sum over the raw readings. Computed sums are rounded to 1 mg
(9 decimals of a tonne) so that floating-point artifacts (`0.30000000000000004`) never reach
clients; raw readings are returned as stored.

## API

Routes live under `/api/v2` (OpenAPI UI `/docs`, JSON `/openapi.json`, committed as
[`openapi.json`](openapi.json)). Errors are RFC 9457 problem details
(`application/problem+json`, stable `code`); validation errors are `400 VALIDATION_FAILED` with
`errors[]`. 🔑 = also accepts `X-API-Key`.

| Method | Path                                                                                        | Permission                                      | What                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/telemetry/readings?source=manual\|import` 🔑                                              | API key `telemetry:ingest` or `telemetry:write` | One reading or an array (≤ 1000) `{ mmsi, time, periodStart?, fuelMeTon, fuelAeTon }` → `202 { received, accepted, duplicates, published }`. All or nothing (`400`/`403`/`404`/`409`); error fields `<index>.<field>`. Only users choose `source`. |
| GET    | `/telemetry/vessels?page&pageSize`                                                          | `telemetry:read`                                | Vessels of the organization with newest reading, `active` flag and number of devices.                                                                                                                                                              |
| GET    | `/telemetry/vessels/:mmsi/readings?from&to&bucket=raw\|1h\|1d&order=asc\|desc&cursor&limit` | `telemetry:read`                                | Time-ordered series (cursor page `{ data, page: { nextCursor, limit } }`), oldest first or `order=desc` newest first; `raw` default 24 h (≤ 31 d), `1h` 7 d (≤ 366 d), `1d` 365 d (≤ 5 y).                                                         |
| GET    | `/telemetry/vessels/:mmsi/readings.csv?from&to&bucket=raw\|1h\|1d`                          | `telemetry:read`                                | The same series (ascending, same defaults and limits) as one streamed CSV file, see _CSV export_.                                                                                                                                                  |
| GET    | `/telemetry/vessels/:mmsi/devices?page&pageSize`                                            | `telemetry:read`                                | Devices of the vessel, read-only: `id`, `name`, `kind`, `status`, `lastSeenAt` (no credentials), by name.                                                                                                                                          |
| GET    | `/telemetry/vessels/:mmsi/summary?from&to`                                                  | `telemetry:read`                                | Totals over `[from, to)` (default 30 days): `readings`, `fuelMeTon`, `fuelAeTon`, `totalFuelTon`, `firstReadingAt`, `lastReadingAt`.                                                                                                               |
| GET    | `/telemetry/vessels/:mmsi/status`                                                           | `telemetry:read`                                | `{ mmsi, active, lastReadingAt, activeWindowMin, lastReading }`.                                                                                                                                                                                   |
| POST   | `/telemetry/devices`                                                                        | `device:manage`                                 | Register a device on a vessel of the organization (`201`); `mqttTopic` in the response for `mqtt` devices.                                                                                                                                         |
| GET    | `/telemetry/devices?mmsi&kind&status&search&orgId&page&pageSize`                            | `device:manage`                                 | Devices of the organization (platform administrators: all, or `orgId`).                                                                                                                                                                            |
| GET    | `/telemetry/devices/:id`                                                                    | `device:manage`                                 | One device (`404` for devices of other organizations).                                                                                                                                                                                             |
| PATCH  | `/telemetry/devices/:id`                                                                    | `device:manage`                                 | Rename, (de)activate, move to another vessel of the same organization, change kind / API key; `null` clears `apiKeyId` / `serialNumber`.                                                                                                           |
| DELETE | `/telemetry/devices/:id`                                                                    | `device:manage`                                 | `204`; the device's readings are kept (with their `deviceId`).                                                                                                                                                                                     |
| GET    | `/telemetry/methodology`                                                                    | any signed-in user                              | Methods implemented here, resolved against the catalog (spec §17).                                                                                                                                                                                 |

Outside the prefix: `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`,
`GET /openapi.json` (not exposed through the gateway).

Path parameters are parsed from the raw segment by the kit (`@MmsiParam()`, `@UuidParam()`): `:mmsi`
is exactly nine digits, `:id` a UUID; anything else is `400 VALIDATION_FAILED` with a field error
(`{ field: 'mmsi', code: 'isMmsi' }`, `{ field: 'id', code: 'isUuid' }`).

**Series pages.** `[from, to)` with `to` defaulting to now and `from` to the bucket's default range
before it; buckets whose start lies in the range. `order=desc` returns the newest points first and
its `nextCursor` continues backwards — the newest readings are `?order=desc&limit=20` (readings up to
`TELEMETRY_MAX_FUTURE_SKEW_MIN` ahead of the server clock need an explicit later `to`; widen `from`
up to the bucket's maximum to look further back). A cursor belongs to its bucket and order: reusing
it with another one is `400 VALIDATION_FAILED` (`field: 'cursor'`).

**CSV export.** `GET …/readings.csv` streams the series of the same `from`, `to` and `bucket`
(ascending) as RFC 4180 CSV: `text/csv; charset=utf-8; header=present`,
`Content-Disposition: attachment; filename="telemetry-<mmsi>-<bucket>-<from>_<to>.csv"` (UTC to the
second, e.g. `20261121T100000Z`; exposed cross-origin), the header line
`time,periodStart,fuelMeTon,fuelAeTon,totalFuelTon,readings,source,deviceId`, CRLF line ends, the
values of the JSON points (empty for `null`: `periodStart`, `source` and `deviceId` exist for raw
readings only). Points are read in keyset batches of 5 000 (one short statement each, never a
transaction across the download) as the client consumes them. Permission, tenancy, the range limits
and the first batch are checked before the first byte, so those errors are ordinary problem
details; a database failure later aborts the connection (logged without bound values) instead of
ending a cut file normally. The size follows the range limits and the vessel's reporting rate (a
meter every minute: about 45 000 lines, 4 MB, for the maximum raw range of 31 days).

**Devices of a vessel.** `GET /telemetry/vessels/:mmsi/devices` lets `telemetry:read` users (fleet
managers) see the meters of a vessel of their organization (platform administrators: any vessel)
without the registry permission: `id` (the `deviceId` of its raw readings), `name`, `kind`, `status`
and `lastSeenAt`; never the API key, serial number, MQTT topic or creator, which stay
`device:manage`. They are the devices of the vessel's current organization, the ones the vessel
overview counts; page-based like the registry (`page`, `pageSize` ≤ 100).

**Ingestion rules.** Readings are validated before anything is stored: `fuelMeTon`/`fuelAeTon`
finite, `≥ 0` and `≤ TELEMETRY_MAX_FUEL_ME_TON` / `TELEMETRY_MAX_FUEL_AE_TON`; `time` ISO-8601 UTC,
at most `TELEMETRY_MAX_FUTURE_SKEW_MIN` ahead of the server clock and at most
`TELEMETRY_MAX_AGE_DAYS` old; `periodStart` before `time` and at most `TELEMETRY_MAX_PERIOD_H`
earlier; at most 1000 readings. Every MMSI must be a live vessel of the FLEET projection
(`404 VESSEL_NOT_FOUND` names the unknown ones) of the caller's organization (`403 FORBIDDEN`;
platform administrators may write for any vessel). Provenance: users post `manual` (default) or
`import`; an API key linked to an `http` device posts as `device` (the device must be active and
report its own vessel), any other key as `api`; MQTT messages are `mqtt`.

**One reading per vessel and instant.** `fuel_readings` is keyed by `(mmsi, time)` (spec §13.4) and
readings are immutable:

- an **exact repeat** — same `periodStart`, `fuelMeTon`, `fuelAeTon` and the same device (`null` for
  readings without a device) — is an idempotent duplicate: counted in `duplicates`, nothing changes
  (retries are safe; the source label is not compared);
- a **different reading** at a stored key — other values, or **another device** of the vessel
  reporting the same instant, even with equal amounts — is a conflict and is never stored: REST
  answers `409 READING_CONFLICT` with an `<index>.time` error per conflicting reading and stores
  nothing of the request (correct or drop those readings and resend; the rest then stores, already
  stored readings count as duplicates); MQTT stores the message's other readings and counts the
  message as `conflict` (a device cannot be answered); both count
  `aisits_telemetry_readings_total{outcome="conflict"}`;
- two different readings of one key **in the same request** are `400 VALIDATION_FAILED`
  (`<index>.time`, code `conflicting_repeat`).

A vessel may have several devices (spares, replacements), but meters of one vessel must report
distinct timestamps — or report through one gateway that combines them into one reading of both
engine groups (`fuelMeTon` + `fuelAeTon`), which is what a reading is. Two meters with aligned
interval boundaries (e.g. a main-engine and an auxiliary-engine meter both reporting at :00) collide
on every reading.

**Storage windows.** A batch is stored per UTC day, one transaction each, oldest day first. All or
nothing still holds: validation, tenancy and — for batches spanning several days — the comparison
with the stored readings happen before the first write, and each day rolls back on a conflict found
in its own transaction. Only a conflicting reading written concurrently between that comparison and a
later day can leave the earlier days stored before the `409`; resending is safe (they count as
duplicates). The split bounds the continuous-aggregate invalidation of a request to the days it holds
readings for (TimescaleDB logs one `[min, max]` range per transaction and chunk).

**Late readings in buckets.** Readings stored more than about an hour after their `time` (store and
forward, imports) appear in the `1h` / `1d` series and summaries after the next policy refresh
(`fuel_hourly` every 15 min, `fuel_daily` hourly); raw readings and the status are immediate. The
refresh re-aggregates the invalidated hours of every vessel (continuous aggregates are refreshed by
time range, not per vessel): a contiguous import of N days costs a refresh of N days, scattered late
readings cost their own days only.

| Code                          | Status | When                                                                                                                                                                                                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_FAILED`           | 400    | invalid body/query (`errors[]` with `<index>.<field>` for readings, `conflicting_repeat` for two readings of one key), a cursor of another bucket or order, a malformed `:mmsi` (`isMmsi`) or `:id` (`isUuid`), `null` for a non-nullable device field |
| `UNAUTHORIZED`                | 401    | no or invalid token; an API key on a route without `@AllowApiKey`                                                                                                                                                                                      |
| `FORBIDDEN`                   | 403    | missing permission, vessel or `orgId` of another organization                                                                                                                                                                                          |
| `INSUFFICIENT_SCOPE`          | 403    | API key without `telemetry:ingest`                                                                                                                                                                                                                     |
| `ORGANIZATION_REQUIRED`       | 403    | a user without an active organization lists vessels or devices                                                                                                                                                                                         |
| `DEVICE_INACTIVE`             | 403    | the API key belongs to an inactive device                                                                                                                                                                                                              |
| `DEVICE_VESSEL_MISMATCH`      | 403    | a device key reports another vessel than the device's                                                                                                                                                                                                  |
| `VESSEL_NOT_FOUND`            | 404    | MMSI not in the FLEET projection (or deleted)                                                                                                                                                                                                          |
| `DEVICE_NOT_FOUND`            | 404    | no device with the id visible to the caller                                                                                                                                                                                                            |
| `DEVICE_NAME_TAKEN`           | 409    | the organization has a device of that name                                                                                                                                                                                                             |
| `DEVICE_API_KEY_TAKEN`        | 409    | the API key is linked to another device of the organization                                                                                                                                                                                            |
| `DEVICE_CREDENTIAL_CONFLICT`  | 409    | a concurrent change left kind and API key of a device inconsistent (reload, retry)                                                                                                                                                                     |
| `READING_CONFLICT`            | 409    | a vessel has a different reading at one of the times already (`errors[]`: `<index>.time`)                                                                                                                                                              |
| `VESSEL_WITHOUT_ORGANIZATION` | 422    | a device for a vessel that belongs to no organization                                                                                                                                                                                                  |

## Events

| Direction | Stream / subject                                                             | Type / payload                                                                      | Consumer name / notes                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| publishes | `FUEL` / `fuel.reading.v1.<mmsi>`                                            | `fuel.reading.recorded.v1` (`FuelReadingRecordedV1`)                                | `{ mmsi, time, periodStart, fuelMeTon, fuelAeTon, deviceId, source }`; `Nats-Msg-Id = <mmsi>:<time ISO>` (JetStream dedup window 2 min; consumers dedupe by `(mmsi, time)`). Consumed by `emission-fuel`. |
| publishes | `AUDIT` / `audit.v1.telemetry`                                               | `audit.recorded.v1`                                                                 | `device.create`, `device.update`, `device.delete`, `fuel_reading.create` (manual entries and imports by users, one record per vessel).                                                                    |
| consumes  | `FLEET` / `fleet.vessel.v1.>`                                                | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1`                               | durable `telemetry-fleet` (idempotent by version: newer snapshots only, tombstones for deletions).                                                                                                        |
| consumes  | core NATS `aisits.telemetry.<deviceId>` (MQTT `aisits/telemetry/<deviceId>`) | raw device JSON `{ time, periodStart?, fuelMeTon, fuelAeTon }` or an array (≤ 1000) | core subscription `telemetry-mqtt`, queue group `telemetry` (replicas share messages). The MMSI is the device's; unknown fields are ignored.                                                              |

Audit records of user entries (`fuel_reading.create`, one per vessel) are published concurrently with
the readings and awaited at most `TELEMETRY_PUBLISH_TIMEOUT_MS`; one still pending completes in the
background (audit is best effort in the kit; failures count in `aisits_audit_failures_total`).

Device messages are accepted only from a registered, active device of kind `mqtt` whose vessel
still belongs to the device's organization; every message is counted by outcome
(`aisits_telemetry_device_messages_total{outcome}`): `accepted`, `duplicate`, `conflict` (some
readings collide with different stored readings and were left out, the others were stored),
`invalid_subject`, `invalid_json`, `invalid_payload`, `unknown_device`, `inactive_device`,
`transport_mismatch`, `vessel_not_found`, `vessel_mismatch`, `error`. Storage errors are retried
three times (core NATS has no redelivery).

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values and prints every problem (spec §4).

| Variable                                                  | Default                                                                      | Notes                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `development`                                                                | `development` \| `test` \| `production` (production refuses the development secrets)                                                                            |
| `SERVICE_NAME` / `SERVICE_VERSION`                        | `telemetry` / `package.json` version                                         | logs, metrics, event `source`, `audit.v1.<name>`, core subscription queue group                                                                                 |
| `HOST` / `PORT`                                           | `0.0.0.0` / `3005`                                                           | spec §3                                                                                                                                                         |
| `LOG_LEVEL` / `LOG_PRETTY`                                | `info` / `true` in development                                               | pino                                                                                                                                                            |
| `DATABASE_URL`                                            | `postgres://telemetry_svc:telemetry_svc@localhost:5432/aisits`               | required in production                                                                                                                                          |
| `DATABASE_SCHEMA`                                         | `telemetry`                                                                  | `search_path=telemetry,public`                                                                                                                                  |
| `DATABASE_POOL_MAX` / `DATABASE_STATEMENT_TIMEOUT_MS`     | `10` / `30000`                                                               |                                                                                                                                                                 |
| `DB_MIGRATE_ON_BOOT`                                      | `true`                                                                       | also `pnpm migrate`                                                                                                                                             |
| `NATS_URL`                                                | `nats://localhost:4222`                                                      | comma separated list allowed; the MQTT gateway runs on the same server; its `max_payload` should be ≥ 4MB (warning at connect otherwise)                        |
| `NATS_DURABLE_PREFIX`                                     | empty                                                                        | test suites only                                                                                                                                                |
| `REDIS_URL`                                               | `redis://localhost:6379`                                                     | base schema; not used by this service                                                                                                                           |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`           | `http://localhost:3001/.well-known/jwks.json`, `ais-its-auth`, `ais-its-api` | access tokens are verified locally                                                                                                                              |
| `AUTH_INTERNAL_URL`                                       | `http://localhost:3001`                                                      | API-key introspection (cached 60 s)                                                                                                                             |
| `INTERNAL_TOKEN`                                          | `dev-internal-token-change-me`                                               | ≥ 16 characters and not the default in production                                                                                                               |
| `CORS_ORIGINS`, `PUBLIC_BASE_URL`                         | see `.env.example`                                                           | CORS exposes `X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag`, `Location` and `Content-Disposition` (CSV file name)                                    |
| `TRUSTED_PROXIES`                                         | `loopback,linklocal,uniquelocal`                                             | proxies whose `X-Forwarded-For` is trusted; **production: the gateway's address or CIDR only** (a warning is logged at boot while the default is in effect)     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER*`     | unset                                                                        | tracing (OTLP/HTTP traces only) when set                                                                                                                        |
| `SHUTDOWN_TIMEOUT_MS`                                     | `30000`                                                                      | graceful shutdown deadline                                                                                                                                      |
| `TELEMETRY_ACTIVE_WINDOW_MIN`                             | `10` (1–1440)                                                                | "active" window W, minutes (`fuel.method_selection`)                                                                                                            |
| `TELEMETRY_MAX_FUTURE_SKEW_MIN`                           | `5` (0–60)                                                                   | accepted clock skew of `time`, minutes                                                                                                                          |
| `TELEMETRY_MAX_AGE_DAYS`                                  | `1825` (1–1825)                                                              | oldest accepted `time` (the 5-year retention)                                                                                                                   |
| `TELEMETRY_MAX_FUEL_ME_TON` / `TELEMETRY_MAX_FUEL_AE_TON` | `500` / `100` (> 0)                                                          | largest fuel of one reading, t (v2 design defaults)                                                                                                             |
| `TELEMETRY_MAX_PERIOD_H`                                  | `24` (1–744)                                                                 | longest `time − periodStart`, hours                                                                                                                             |
| `TELEMETRY_PUBLISH_TIMEOUT_MS`                            | `5000`                                                                       | JetStream ack timeout per publish; while NATS stalls a request waits at most this long after the commit (readings and audit records are published concurrently) |
| `TELEMETRY_RELAY_INTERVAL_MS`                             | `5000` (`0` disables)                                                        | relay poll interval                                                                                                                                             |
| `TELEMETRY_RELAY_AFTER_S`                                 | `30`                                                                         | grace period before the relay republishes an unpublished reading                                                                                                |
| `TELEMETRY_RELAY_BATCH_SIZE`                              | `500`                                                                        | readings per relay transaction (at most 20 transactions per tick)                                                                                               |

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` packages
come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir <central repo> infra:up     # postgres, nats (with MQTT on 1883), valkey, … (or any reachable instances)
pnpm dev                               # watch mode (SWC, decorator metadata)
curl -s localhost:3005/health/ready
open http://localhost:3005/docs        # Swagger UI
```

Try it (tokens and API keys come from the auth service, e.g. `pnpm seed:demo` there; the vessel must
exist in the fleet service):

```bash
curl -s -X POST localhost:3005/api/v2/telemetry/readings -H "x-api-key: $TELEMETRY_KEY" \
  -H 'content-type: application/json' \
  -d '[{"mmsi":525005223,"time":"2026-11-21T10:00:00Z","periodStart":"2026-11-21T09:00:00Z","fuelMeTon":0.42,"fuelAeTon":0.05}]'
curl -s "localhost:3005/api/v2/telemetry/vessels/525005223/readings?bucket=1h" -H "authorization: Bearer $TOKEN"
curl -s "localhost:3005/api/v2/telemetry/vessels/525005223/readings?order=desc&limit=20" -H "authorization: Bearer $TOKEN"
curl -sOJ "localhost:3005/api/v2/telemetry/vessels/525005223/readings.csv?bucket=1h" -H "authorization: Bearer $TOKEN"
# a registered mqtt device (POST /api/v2/telemetry/devices) publishing like a fuel meter:
mosquitto_pub -h localhost -p 1883 -q 1 -t "aisits/telemetry/$DEVICE_ID" \
  -m '{"time":"2026-11-21T10:05:00Z","fuelMeTon":0.04,"fuelAeTon":0.01}'
```

| Script                                          | What                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                                      | watch mode (`nest start --watch --builder swc`)                         |
| `pnpm build` / `pnpm start`                     | compile with `tsc` to `dist/` / run it                                  |
| `pnpm start:prod`                               | run `dist/` with `NODE_ENV=production`                                  |
| `pnpm migrate`                                  | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`)       |
| `pnpm openapi`                                  | build, then write `openapi.json` without any infrastructure (commit it) |
| `pnpm openapi:check`                            | fail when the committed `openapi.json` differs from `dist/` (CI)        |
| `pnpm test` / `pnpm test:int` / `pnpm test:all` | unit tests / integration tests (Docker) / both                          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`  | ESLint, `tsc --noEmit`, Prettier                                        |

## Testing

- **Unit** (`pnpm test`, no Docker, `src/**/*.spec.ts`): plausibility rules and dedup
  (`domain/fuel-reading`), bucket alignment, summary planning and totals (`domain/fuel-aggregation`),
  the "active" rule incl. the legacy `/10 000` bug as a regression case (`domain/telemetry-status`),
  MQTT payload/subject parsing, the body pipe, publisher/relay failure handling, the services' tenancy
  and attribution rules, series order and cursors, the CSV formatting and the batching of the export
  (incl. a sanitized failure after the first batch), configuration, and the handbook's rollout and
  troubleshooting notes and the 0.2.0 changelog entry they rely on (`src/docs.spec.ts`).
- **Integration** (`pnpm test:int`, Docker; containers `timescale/timescaledb-ha:pg17` and
  `nats:2.11-alpine` — JetStream, the MQTT gateway and `max_payload` 4MB like the platform's
  `nats.conf` — started once by `test/support/global-setup.ts` with the kit's
  `testInfraGlobalSetup({ postgres: true, nats: { mqtt: true } })`, which also provisions the schema;
  files read the endpoints with `testInfra('nats')`; signed test JWTs and a fake API-key
  introspection from the kit):
  - `readings` — REST ingest with an API key and a user token, single object and arrays,
    duplicates and `409 READING_CONFLICT` (all or nothing), in-request contradictions, validation
    errors, tenancy (`404 VESSEL_NOT_FOUND`, `403`), scopes, device-key attribution, two devices on
    one vessel reporting the same instant, events read back from `FUEL` (subject, `Nats-Msg-Id`,
    payload), raw/1h/1d series before and after an aggregate refresh, newest-first pages and cursors,
    the CSV export (values, buckets, an empty range, headers, CORS, problem details before streaming),
    summaries, status, the vessel overview, malformed path parameters (incl. the `:mmsi` forms 0.1.0
    coerced to a number);
  - `relay` — a `FUEL` stream deleted at runtime is re-created by the next publish (no restart);
    readings stored while a sealed `FUEL` stream rejects them stay queued with `published_at = NULL`
    and are republished by the relay once the stream is replaced; republication keeps the
    `Nats-Msg-Id`; relaying a reading of a compressed five-vessel chunk decompresses only that
    vessel's batch;
  - `nats-stall` — a NATS server of its own (the kit's `testNatsConfig()`) frozen with
    `docker pause`: a user's request for three vessels answers within `TELEMETRY_PUBLISH_TIMEOUT_MS`
    (audit records included) and leaves the readings queued;
  - `device-messages` — the MQTT path on the core subject: accepted readings (stored, published,
    `lastSeenAt`), store-and-forward arrays, duplicates, a second meter of the vessel reporting the
    same instant (`conflict`, the rest of its message stored), and every rejection outcome counted;
  - `mqtt-gateway` — a real MQTT client (QoS 1) against the MQTT gateway of the shared test NATS
    (`testInfra('nats').nats.mqttUrl`);
  - `devices` — registry CRUD, validation (incl. `null` for non-nullable fields), unique
    names/keys, tenancy, permissions, audit events, the read-only devices of a vessel;
  - `fleet-projection` — ownership changes, out-of-order snapshots, deletions and MMSI changes;
  - `aggregates` — historical imports folded in by the real refresh-policy jobs, one invalidation
    range per UTC day of a request (read from the TimescaleDB catalog), duplicates, conflicts and
    inserts in compressed chunks;
  - `app` — health, migrations/policies, a retried migration `0002` that failed halfway,
    problem details, the catalogued methodology, OpenAPI, metrics.
- `TEST_LOG_LEVEL=debug pnpm test:int` shows the service logs (silent by default).
  `TESTCONTAINERS_RYUK_DISABLED=true` is set by the configuration; the global teardown stops the
  containers.

## Operations

- **Image** `ghcr.io/darmawanweb/ais-its-telemetry-service` (multi-stage `node:24-alpine`, `USER node`,
  production dependencies only, `HEALTHCHECK` on `/health/live`). CI pushes `main` and
  `sha-<commit>`, releases push `<version>`, `<major>.<minor>` and `latest`. Local build with BuildKit
  secrets only:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-telemetry-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-telemetry-service .
  ```

- **Replicas**: any number, rolling updates included: the relay shares the backlog
  (`FOR UPDATE SKIP LOCKED`), the MQTT subscription is a queue group, `telemetry-fleet` is a shared
  durable with an idempotent, versioned projection. **Rolling update from 0.1.0**: no migration, and
  both versions share the tables, subjects, queue group and durable, so ingest, MQTT, the relay and
  the projection run on mixed replicas, and ascending series pages without `order` continue across
  them (each version reads the other's ascending cursors). Only 0.2.0 replicas answer the new API:
  a 0.1.0 replica answers every request with `order`, `order=asc` included, with
  `400 VALIDATION_FAILED` (`{ field: 'order', code: 'whitelistValidation' }`), and `…/readings.csv`
  and `/telemetry/vessels/:mmsi/devices` with `404 NOT_FOUND`. Switch the web app to `order=desc`,
  the CSV export and the devices list only once every telemetry replica runs 0.2.0.
- **Health**: `/health/live` (process), `/health/ready` (database, NATS; `503` while draining or when
  the FLEET consumer stalls).
- **Metrics** (`/metrics`, prefix `aisits_`): kit HTTP RED metrics, event metrics
  (`aisits_events_published_total`, `aisits_events_consumed_total{stream,consumer,outcome}`,
  `aisits_events_invalid_total`, `aisits_event_handler_duration_seconds`), core subscription metrics
  (`aisits_core_messages_total{subscription,outcome}`, `aisits_core_handler_duration_seconds`) and
  the domain metrics:
  - `aisits_telemetry_readings_total{source,outcome}` — `accepted`, `duplicate`, `conflict`,
    `rejected` (MQTT);
  - `aisits_telemetry_device_messages_total{outcome}` — MQTT device messages (outcomes above);
  - `aisits_telemetry_reading_lag_seconds{source}` — storage time minus reading time;
  - `aisits_telemetry_relayed_total{outcome}` — relay republications (`published`, `failed`, `orphaned`);
  - `aisits_telemetry_unpublished_readings`, `aisits_telemetry_oldest_unpublished_seconds` — relay backlog.
- **Logs**: pino JSON (`service`, `version`, `requestId`, `traceId`, `principal`); rejected device
  messages log the device id and the reason (the validation messages for invalid payloads), not the
  message body.
- **Troubleshooting**
  - _`aisits_telemetry_unpublished_readings` grows / `oldest_unpublished_seconds` > 60_: NATS or the
    `FUEL` stream is unavailable (log `Publishing fuel readings failed; the relay will retry`). Nothing
    is lost: readings stay in `fuel_readings_unpublished` and are relayed once JetStream answers. A
    deleted `FUEL` stream is re-created by the next publish (log
    `Stream FUEL was missing: re-created, retrying the publish`), no restart needed.
    While NATS stalls, ingest requests wait at most `TELEMETRY_PUBLISH_TIMEOUT_MS` after the commit
    (users' audit records included; the log `Audit records of the readings still pending` tells).
  - _Startup warnings_: `max_payload` below 4 MiB (set `max_payload: 4MB` on the NATS server) and, in
    production, the default `TRUSTED_PROXIES` (set it to the gateway's address or CIDR).
  - _A CSV download ends with a network error_: the database failed after the first bytes (log
    `Fuel series export failed while streaming`); retry, or narrow the range.
  - _`409 READING_CONFLICT` / outcome `conflict` /
    `aisits_telemetry_readings_total{outcome="conflict"}` grows_: two producers report the same
    vessel and instant with different readings — typically two meters of one vessel with aligned
    intervals, or a manual entry or import overlapping device data. Find them with
    `SELECT device_id, source, count(*) FROM telemetry.fuel_readings WHERE mmsi = … GROUP BY 1, 2`;
    give the meters distinct timestamps, combine them behind one gateway, or deactivate the spare.
  - _Every reading answers `404 VESSEL_NOT_FOUND`_: the FLEET projection lacks the vessel — check
    `aisits_events_consumed_total{consumer="telemetry-fleet"}`, the fleet service (it can republish
    with `POST /api/v2/vessels/:id/republish`) and `SELECT * FROM telemetry.vessels WHERE mmsi = …`.
  - _Device messages are not stored_: look at `aisits_telemetry_device_messages_total{outcome}`
    (`unknown_device`: wrong topic or unregistered device; `inactive_device`; `transport_mismatch`: an
    `http` device publishing over MQTT; `vessel_mismatch`: the vessel changed organization —
    re-register the device). The topic must be `aisits/telemetry/<deviceId>` exactly.
  - _A late import is missing from `1h`/`1d` buckets_: it is folded in by the next policy refresh
    (≤ 15 min / ≤ 1 h); each UTC day of a request was stored in its own transaction, so only the
    imported days are re-aggregated. Manual refresh:
    `CALL refresh_continuous_aggregate('telemetry.fuel_hourly', '<from>', '<to>')`, then
    `fuel_daily`.
  - _Policies_: `SELECT * FROM timescaledb_information.jobs WHERE hypertable_schema = 'telemetry'`
    (compression, retention, aggregate refresh); `job_stats` shows failures.
- **Release**: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new version,
  bump `package.json`, tag `v<version>`.

## Legacy parity notes

The MVP stored fuel data in two MongoDB collections without authentication or validation
(`be-legacy/src/models/Telemetry.ts` with `/api/v1/telemetry`, and `src/models/ships/Telemetry.ts`
`FuelData` with `/api/v1/ships/fuel-data`). v2 keeps their capabilities in one time-series model:

| Legacy                                                                                                                                                        | v2                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /telemetry` `{ mmsi, fuel: [{ fuelConsumptionMeTon, fuelConsumptionAeTon, totalFuelConsumptionTon, timestamp }] }` (`TelemetryService.createTelemetry`) | `POST /api/v2/telemetry/readings` with `[{ mmsi, time: timestamp, fuelMeTon, fuelAeTon }]`; the total is derived (`totalFuelTon` in every response), not stored.                                                                                     |
| `POST /telemetry/:mmsi/fuel` (`updateFuelConsumptionByMMSI`, appends one entry)                                                                               | `POST /api/v2/telemetry/readings` with one reading.                                                                                                                                                                                                  |
| `POST /ships/fuel-data` `{ mmsi, fuelLogs: [{ fuelME, fuelAE, timestamp? }] }` (`FuelDataRepository.create`)                                                  | `POST /api/v2/telemetry/readings` (`fuelME` → `fuelMeTon`, `fuelAE` → `fuelAeTon`, Decimal128 → `double precision`); `time` is required (legacy defaulted to `Date.now`).                                                                            |
| `GET /telemetry`, `GET /ships/fuel-data` (everything, every tenant)                                                                                           | `GET /api/v2/telemetry/vessels` (own organization) and the per-vessel series.                                                                                                                                                                        |
| `GET /telemetry/:mmsi` (`getTelemetryByMmsi`)                                                                                                                 | `GET /api/v2/telemetry/vessels/:mmsi/readings?from&to&bucket=raw\|1h\|1d` and `…/summary`.                                                                                                                                                           |
| `FuelDataRepository.getLatestByMMSI`                                                                                                                          | `GET /api/v2/telemetry/vessels/:mmsi/status` → `lastReading`.                                                                                                                                                                                        |
| `FuelDataRepository.isActive` (`(now − createdAt) / 10 000 ≤ 1`)                                                                                              | `status.active` = newest reading at most `TELEMETRY_ACTIVE_WINDOW_MIN` (10) **minutes** old — the `/10 000` divisor made the legacy window 10 s (spec §15.5). Age is measured from the reading's `time`, so imported history never counts as active. |
| `PUT /telemetry/:mmsi`, `DELETE /telemetry/:mmsi`, `DELETE /ships/fuel-data/:mmsi`                                                                            | Not offered: readings are an append-only measurement log, idempotent by `(mmsi, time)`, and already published to `FUEL`, whose consumers have no retraction event. Retention (5 y) removes old data.                                                 |
| Ingest through the AIS handler with `validMMSIs`                                                                                                              | Every vessel of the fleet; devices, partners and users ingest directly, MQTT included (new).                                                                                                                                                         |

New in v2: tenancy, permissions and API keys; plausibility rules; idempotency; the device registry
and MQTT; hourly/daily aggregates and exact summaries; reliable publication to `FUEL`.

## Methodology & references

Every formula, constant, threshold and rule is traceable to its source (spec §17): the implementing
function carries a `@method <id>` TSDoc tag with units and `@see` links, the id is listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/telemetry/methodology` from `@darmawanweb/ais-its-contracts/references`) and
described in [`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) §7.1 and §20.2 and the catalog
`docs/references/methods.json`. ⚠️ = needs a citation from the thesis (`needsCitation`).

| Method id                                                                                   | Implemented by                                                                                                                                                                                                                   | Sources                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fuel.method_selection`](../../docs/METHODOLOGY.md#fuel.method_selection) ⚠️               | `src/domain/telemetry-status.ts#isTelemetryActive` — the "active" rule `t_now − t_last ≤ W` (min)                                                                                                                                | legacy MVP (`be-legacy/src/repositories/ships/fuel-data.repository.ts#isActive`), [platform spec §13.4, §15.5](../../docs/PLATFORM_SPEC.md)                                                               |
| [`telemetry.fuel_reading_usage`](../../docs/METHODOLOGY.md#telemetry.fuel_reading_usage) ⚠️ | `src/domain/fuel-aggregation.ts#addTotals`, `#totalFuelTon` — `FC_x = Σ r.fuel_x`, `FC = FC_ME + FC_AE` (t)                                                                                                                      | legacy MVP (`be-legacy/src/services/cii/cii.service.ts#calculateCII`, `src/models/ships/Telemetry.ts`), [platform spec §13.4](../../docs/PLATFORM_SPEC.md)                                                |
| [`telemetry.reading_validation`](../../docs/METHODOLOGY.md#telemetry.reading_validation) ⚠️ | `src/domain/fuel-reading.ts#readingViolations` — plausibility rules (≥ 0, maxima, skew, age, period); `#batchViolations`, `#repeatViolations`, `#compareWithStored` — one reading per vessel and instant (duplicate vs conflict) | platform spec §13.4 (skew ≤ 5 min, batch ≤ 1000, idempotent by `(mmsi, time)`); the fuel maxima, the 24-h period, the 5-year age and the conflict rule are v2 design decisions without an external source |

The meaning of one reading (tonnes per interval vs. a cumulative counter) is not specified by the
legacy code and needs the device specification (catalog note of `telemetry.fuel_reading_usage`);
v2 treats a reading as the fuel burnt in the period ending at `time`.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
