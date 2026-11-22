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
and the contracts [`@darmawanweb/ais-its-contracts`](https://github.com/DarmawanWeb/ais-its-contracts).
The normative engineering spec is [`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) §13.4 in the
central repository ([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose and responsibilities

The service **owns**:

- **Fuel readings** — `fuel_readings` hypertable (PK `(mmsi, time)`, idempotent), with hourly and
  daily continuous aggregates for bucketed queries and summaries.
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
  S->>DB: BEGIN · INSERT … ON CONFLICT (mmsi, time) DO NOTHING · queue new rows · COMMIT
  S->>JS: publish fuel.reading.recorded.v1 (Nats-Msg-Id <mmsi>:<time>)
  JS-->>S: ack
  S->>DB: published_at = now(), dequeue (one transaction)
  S-->>C: 202 { received, accepted, duplicates, published }
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
| `src/modules/readings/`                | REST ingest and queries, the shared ingestion pipeline, MQTT payload parsing, publisher, relay, metrics       |
| `src/modules/devices/`                 | device registry (controller → service → repository, DTOs)                                                     |
| `src/modules/vessels/`                 | FLEET projection repository and the tenancy rules built on it                                                 |
| `src/modules/methodology/`             | `GET /api/v2/telemetry/methodology` (spec §17)                                                                |
| `src/consumers/`                       | `telemetry-fleet` durable consumer, `telemetry-mqtt` core subscription                                        |
| `src/db/schema.ts`, `migrations/*.sql` | drizzle mirror of the forward-only SQL migrations                                                             |
| `test/*.int.test.ts`                   | integration tests against TimescaleDB and NATS containers                                                     |

## Data model

Schema `telemetry`, owned by `telemetry_svc`; migrations in [`migrations/`](migrations) are
forward-only and checksummed (never edit an applied file — add `NNNN_<change>.sql`).

| Table / view                                         | Columns (essentials)                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fuel_readings` (hypertable on `time`, 7-day chunks) | `time`, `mmsi`, `device_id`, `period_start`, `fuel_me_ton`, `fuel_ae_ton` (≥ 0, t), `source` (`device`\|`mqtt`\|`api`\|`manual`\|`import`), `received_at`, `published_at` | PK `(mmsi, time)`: duplicates are ignored (first wins). `time` is the end of the measured period (since `period_start` when given). Compressed after 7 days (`segmentby mmsi`, `orderby time DESC`), retention 5 years. `published_at` is `NULL` until the reading is in `FUEL`. |
| `fuel_readings_unpublished`                          | `mmsi`, `time`, `received_at`                                                                                                                                             | Work queue of the relay: one row per reading with `published_at IS NULL`, written and removed in the same transactions as the reading / its `published_at`, locked with `FOR UPDATE SKIP LOCKED` (replicas share the backlog).                                                   |
| `fuel_hourly` (continuous aggregate)                 | `bucket` (UTC hour), `mmsi`, `fuel_me_ton`, `fuel_ae_ton`, `readings`, `first_time`, `last_time`                                                                          | Real-time aggregation; refresh policy every 15 min up to `now − 1 h`, refresh window without a start (invalidation-driven, so late readings and imports of any age are folded in). Retention 5 years.                                                                            |
| `fuel_daily` (hierarchical, on `fuel_hourly`)        | same columns per UTC day                                                                                                                                                  | Real-time; refresh policy hourly up to `now − 1 day`, window without a start. Kept indefinitely.                                                                                                                                                                                 |
| `vessels` (FLEET projection)                         | `mmsi` PK, `vessel_id` unique, `org_id`, `name`, `status`, `source_updated_at`, `deleted_at`                                                                              | Snapshots apply only when newer (`updatedAt`); deletions leave a tombstone so late, older snapshots stay ignored; an MMSI change moves the row.                                                                                                                                  |
| `devices`                                            | `id`, `org_id`, `mmsi`, `name`, `kind` (`mqtt`\|`http`), `api_key_id`, `status` (`active`\|`inactive`), `serial_number`, `last_seen_at`, `created_by`                     | `org_id` is the organization of the vessel at registration. `http` devices need `api_key_id`, `mqtt` devices have none (`CHECK`). Unique `(org_id, name)` and `(org_id, api_key_id)`. `last_seen_at` is updated at most once a minute.                                           |

Bucketed queries read the continuous aggregates; summaries combine whole UTC days from
`fuel_daily`, whole hours from `fuel_hourly` and the unaligned edges from `fuel_readings`, so the
total over any range equals the sum over the raw readings.

## API

Routes live under `/api/v2` (OpenAPI UI `/docs`, JSON `/openapi.json`, committed as
[`openapi.json`](openapi.json)). Errors are RFC 9457 problem details
(`application/problem+json`, stable `code`); validation errors are `400 VALIDATION_FAILED` with
`errors[]`. 🔑 = also accepts `X-API-Key`.

| Method | Path                                                                        | Permission                                      | What                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/telemetry/readings?source=manual\|import` 🔑                              | API key `telemetry:ingest` or `telemetry:write` | One reading or an array (≤ 1000) `{ mmsi, time, periodStart?, fuelMeTon, fuelAeTon }` → `202 { received, accepted, duplicates, published }`. All or nothing; error fields `<index>.<field>`. Only users choose `source`. |
| GET    | `/telemetry/vessels?page&pageSize`                                          | `telemetry:read`                                | Vessels of the organization with newest reading, `active` flag and number of devices.                                                                                                                                    |
| GET    | `/telemetry/vessels/:mmsi/readings?from&to&bucket=raw\|1h\|1d&cursor&limit` | `telemetry:read`                                | Ascending series (cursor page `{ data, page: { nextCursor, limit } }`); `raw` default 24 h (≤ 31 d), `1h` 7 d (≤ 366 d), `1d` 365 d (≤ 5 y).                                                                             |
| GET    | `/telemetry/vessels/:mmsi/summary?from&to`                                  | `telemetry:read`                                | Totals over `[from, to)` (default 30 days): `readings`, `fuelMeTon`, `fuelAeTon`, `totalFuelTon`, `firstReadingAt`, `lastReadingAt`.                                                                                     |
| GET    | `/telemetry/vessels/:mmsi/status`                                           | `telemetry:read`                                | `{ mmsi, active, lastReadingAt, activeWindowMin, lastReading }`.                                                                                                                                                         |
| POST   | `/telemetry/devices`                                                        | `device:manage`                                 | Register a device on a vessel of the organization (`201`); `mqttTopic` in the response for `mqtt` devices.                                                                                                               |
| GET    | `/telemetry/devices?mmsi&kind&status&search&orgId&page&pageSize`            | `device:manage`                                 | Devices of the organization (platform administrators: all, or `orgId`).                                                                                                                                                  |
| GET    | `/telemetry/devices/:id`                                                    | `device:manage`                                 | One device (`404` for devices of other organizations).                                                                                                                                                                   |
| PATCH  | `/telemetry/devices/:id`                                                    | `device:manage`                                 | Rename, (de)activate, move to another vessel of the same organization, change kind / API key; `null` clears `apiKeyId` / `serialNumber`.                                                                                 |
| DELETE | `/telemetry/devices/:id`                                                    | `device:manage`                                 | `204`; the device's readings are kept (with their `deviceId`).                                                                                                                                                           |
| GET    | `/telemetry/methodology`                                                    | any signed-in user                              | Methods implemented here, resolved against the catalog (spec §17).                                                                                                                                                       |

Outside the prefix: `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`,
`GET /openapi.json` (not exposed through the gateway).

**Ingestion rules.** Readings are validated before anything is stored: `fuelMeTon`/`fuelAeTon`
finite, `≥ 0` and `≤ TELEMETRY_MAX_FUEL_ME_TON` / `TELEMETRY_MAX_FUEL_AE_TON`; `time` ISO-8601 UTC,
at most `TELEMETRY_MAX_FUTURE_SKEW_MIN` ahead of the server clock and at most
`TELEMETRY_MAX_AGE_DAYS` old; `periodStart` before `time` and at most `TELEMETRY_MAX_PERIOD_H`
earlier; at most 1000 readings. Every MMSI must be a live vessel of the FLEET projection
(`404 VESSEL_NOT_FOUND` names the unknown ones) of the caller's organization (`403 FORBIDDEN`;
platform administrators may write for any vessel). A repeated `(mmsi, time)` — in the request or
already stored — is counted in `duplicates` and changes nothing. Provenance: users post `manual`
(default) or `import`; an API key linked to an `http` device posts as `device` (the device must be
active and report its own vessel), any other key as `api`; MQTT messages are `mqtt`.

**Late readings in buckets.** Readings stored more than about an hour after their `time` (store and
forward, imports) appear in the `1h` / `1d` series and summaries after the next policy refresh
(`fuel_hourly` every 15 min, `fuel_daily` hourly); raw readings and the status are immediate.

| Code                          | Status | When                                                                                |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`           | 400    | invalid body/query (`errors[]` with `<index>.<field>` for readings), foreign cursor |
| `UNAUTHORIZED`                | 401    | no or invalid token; an API key on a route without `@AllowApiKey`                   |
| `FORBIDDEN`                   | 403    | missing permission, vessel or `orgId` of another organization                       |
| `INSUFFICIENT_SCOPE`          | 403    | API key without `telemetry:ingest`                                                  |
| `ORGANIZATION_REQUIRED`       | 403    | a user without an active organization lists vessels or devices                      |
| `DEVICE_INACTIVE`             | 403    | the API key belongs to an inactive device                                           |
| `DEVICE_VESSEL_MISMATCH`      | 403    | a device key reports another vessel than the device's                               |
| `VESSEL_NOT_FOUND`            | 404    | MMSI not in the FLEET projection (or deleted)                                       |
| `DEVICE_NOT_FOUND`            | 404    | no device with the id visible to the caller                                         |
| `DEVICE_NAME_TAKEN`           | 409    | the organization has a device of that name                                          |
| `DEVICE_API_KEY_TAKEN`        | 409    | the API key is linked to another device of the organization                         |
| `VESSEL_WITHOUT_ORGANIZATION` | 422    | a device for a vessel that belongs to no organization                               |

## Events

| Direction | Stream / subject                                                             | Type / payload                                                                      | Consumer name / notes                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| publishes | `FUEL` / `fuel.reading.v1.<mmsi>`                                            | `fuel.reading.recorded.v1` (`FuelReadingRecordedV1`)                                | `{ mmsi, time, periodStart, fuelMeTon, fuelAeTon, deviceId, source }`; `Nats-Msg-Id = <mmsi>:<time ISO>` (JetStream dedup window 2 min; consumers dedupe by `(mmsi, time)`). Consumed by `emission-fuel`. |
| publishes | `AUDIT` / `audit.v1.telemetry`                                               | `audit.recorded.v1`                                                                 | `device.create`, `device.update`, `device.delete`, `fuel_reading.create` (manual entries and imports by users, one record per vessel).                                                                    |
| consumes  | `FLEET` / `fleet.vessel.v1.>`                                                | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1`                               | durable `telemetry-fleet` (idempotent by version: newer snapshots only, tombstones for deletions).                                                                                                        |
| consumes  | core NATS `aisits.telemetry.<deviceId>` (MQTT `aisits/telemetry/<deviceId>`) | raw device JSON `{ time, periodStart?, fuelMeTon, fuelAeTon }` or an array (≤ 1000) | core subscription `telemetry-mqtt`, queue group `telemetry` (replicas share messages). The MMSI is the device's; unknown fields are ignored.                                                              |

Device messages are accepted only from a registered, active device of kind `mqtt` whose vessel
still belongs to the device's organization; every message is counted by outcome
(`aisits_telemetry_device_messages_total{outcome}`): `accepted`, `duplicate`, `invalid_subject`,
`invalid_json`, `invalid_payload`, `unknown_device`, `inactive_device`, `transport_mismatch`,
`vessel_not_found`, `vessel_mismatch`, `error`. Storage errors are retried three times (core NATS
has no redelivery).

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values and prints every problem (spec §4).

| Variable                                                  | Default                                                                      | Notes                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `development`                                                                | `development` \| `test` \| `production` (production refuses the development secrets)    |
| `SERVICE_NAME` / `SERVICE_VERSION`                        | `telemetry` / `package.json` version                                         | logs, metrics, event `source`, `audit.v1.<name>`, core subscription queue group         |
| `HOST` / `PORT`                                           | `0.0.0.0` / `3005`                                                           | spec §3                                                                                 |
| `LOG_LEVEL` / `LOG_PRETTY`                                | `info` / `true` in development                                               | pino                                                                                    |
| `DATABASE_URL`                                            | `postgres://telemetry_svc:telemetry_svc@localhost:5432/aisits`               | required in production                                                                  |
| `DATABASE_SCHEMA`                                         | `telemetry`                                                                  | `search_path=telemetry,public`                                                          |
| `DATABASE_POOL_MAX` / `DATABASE_STATEMENT_TIMEOUT_MS`     | `10` / `30000`                                                               |                                                                                         |
| `DB_MIGRATE_ON_BOOT`                                      | `true`                                                                       | also `pnpm migrate`                                                                     |
| `NATS_URL`                                                | `nats://localhost:4222`                                                      | comma separated list allowed; the MQTT gateway runs on the same server                  |
| `NATS_DURABLE_PREFIX`                                     | empty                                                                        | test suites only                                                                        |
| `REDIS_URL`                                               | `redis://localhost:6379`                                                     | base schema; not used by this service                                                   |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`           | `http://localhost:3001/.well-known/jwks.json`, `ais-its-auth`, `ais-its-api` | access tokens are verified locally                                                      |
| `AUTH_INTERNAL_URL`                                       | `http://localhost:3001`                                                      | API-key introspection (cached 60 s)                                                     |
| `INTERNAL_TOKEN`                                          | `dev-internal-token-change-me`                                               | ≥ 16 characters and not the default in production                                       |
| `CORS_ORIGINS`, `PUBLIC_BASE_URL`, `TRUSTED_PROXIES`      | see `.env.example`                                                           |                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                             | unset                                                                        | tracing when set                                                                        |
| `SHUTDOWN_TIMEOUT_MS`                                     | `30000`                                                                      | graceful shutdown deadline                                                              |
| `TELEMETRY_ACTIVE_WINDOW_MIN`                             | `10` (1–1440)                                                                | "active" window W, minutes (`fuel.method_selection`)                                    |
| `TELEMETRY_MAX_FUTURE_SKEW_MIN`                           | `5` (0–60)                                                                   | accepted clock skew of `time`, minutes                                                  |
| `TELEMETRY_MAX_AGE_DAYS`                                  | `1825` (1–1825)                                                              | oldest accepted `time` (the 5-year retention)                                           |
| `TELEMETRY_MAX_FUEL_ME_TON` / `TELEMETRY_MAX_FUEL_AE_TON` | `500` / `100` (> 0)                                                          | largest fuel of one reading, t (v2 design defaults)                                     |
| `TELEMETRY_MAX_PERIOD_H`                                  | `24` (1–744)                                                                 | longest `time − periodStart`, hours                                                     |
| `TELEMETRY_PUBLISH_TIMEOUT_MS`                            | `5000`                                                                       | JetStream ack timeout per publish (a request waits at most this long while NATS stalls) |
| `TELEMETRY_RELAY_INTERVAL_MS`                             | `5000` (`0` disables)                                                        | relay poll interval                                                                     |
| `TELEMETRY_RELAY_AFTER_S`                                 | `30`                                                                         | grace period before the relay republishes an unpublished reading                        |
| `TELEMETRY_RELAY_BATCH_SIZE`                              | `500`                                                                        | readings per relay transaction (at most 20 transactions per tick)                       |

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
  and attribution rules, configuration.
- **Integration** (`pnpm test:int`, Docker; containers `timescale/timescaledb-ha:pg17` and
  `nats:2.11-alpine` started once by `test/support/global-setup.ts`; signed test JWTs and a fake
  API-key introspection from the kit):
  - `readings` — REST ingest with an API key and a user token, single object and arrays,
    duplicates, validation errors, tenancy (`404 VESSEL_NOT_FOUND`, `403`), scopes, device-key
    attribution, events read back from `FUEL` (subject, `Nats-Msg-Id`, payload), raw/1h/1d series
    before and after an aggregate refresh, summaries, status, the vessel overview;
  - `relay` — readings stored while the `FUEL` stream is missing stay queued with
    `published_at = NULL` and are republished by the relay; republication keeps the `Nats-Msg-Id`;
  - `device-messages` — the MQTT path on the core subject: accepted readings (stored, published,
    `lastSeenAt`), store-and-forward arrays, duplicates, and every rejection outcome counted;
  - `mqtt-gateway` — a real MQTT client (QoS 1) against a NATS server with the MQTT gateway enabled;
  - `devices` — registry CRUD, validation, unique names/keys, tenancy, permissions, audit events;
  - `fleet-projection` — ownership changes, out-of-order snapshots, deletions and MMSI changes;
  - `aggregates` — historical imports folded in by the real refresh-policy jobs, duplicates and
    inserts in compressed chunks;
  - `app` — health, migrations/policies, problem details, OpenAPI, metrics.
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

- **Health**: `/health/live` (process), `/health/ready` (database, NATS; `503` while draining or when
  the FLEET consumer stalls).
- **Metrics** (`/metrics`, prefix `aisits_`): kit HTTP RED metrics, event metrics
  (`aisits_events_published_total`, `aisits_events_consumed_total{stream,consumer,outcome}`,
  `aisits_events_invalid_total`, `aisits_event_handler_duration_seconds`), core subscription metrics
  (`aisits_core_messages_total{subscription,outcome}`, `aisits_core_handler_duration_seconds`) and
  the domain metrics:
  - `aisits_telemetry_readings_total{source,outcome}` — `accepted`, `duplicate`, `rejected` (MQTT);
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
    is lost: readings stay in `fuel_readings_unpublished` and are relayed once JetStream answers.
    While NATS stalls, ingest requests wait at most `TELEMETRY_PUBLISH_TIMEOUT_MS`.
  - _Every reading answers `404 VESSEL_NOT_FOUND`_: the FLEET projection lacks the vessel — check
    `aisits_events_consumed_total{consumer="telemetry-fleet"}`, the fleet service (it can republish
    with `POST /api/v2/vessels/:id/republish`) and `SELECT * FROM telemetry.vessels WHERE mmsi = …`.
  - _Device messages are not stored_: look at `aisits_telemetry_device_messages_total{outcome}`
    (`unknown_device`: wrong topic or unregistered device; `inactive_device`; `transport_mismatch`: an
    `http` device publishing over MQTT; `vessel_mismatch`: the vessel changed organization —
    re-register the device). The topic must be `aisits/telemetry/<deviceId>` exactly.
  - _A late import is missing from `1h`/`1d` buckets_: it is folded in by the next policy refresh
    (≤ 15 min / ≤ 1 h). Send imports in chronological batches: each batch invalidates the range of
    its readings. Manual refresh:
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
described in [`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) §7.1 and the catalog
`docs/references/methods.json`. ⚠️ = needs a citation from the thesis (`needsCitation`).

| Method id                                                                                   | Implemented by                                                                                              | Sources                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fuel.method_selection`](../../docs/METHODOLOGY.md#fuel.method_selection) ⚠️               | `src/domain/telemetry-status.ts#isTelemetryActive` — the "active" rule `t_now − t_last ≤ W` (min)           | legacy MVP (`be-legacy/src/repositories/ships/fuel-data.repository.ts#isActive`), [platform spec §13.4, §15.5](../../docs/PLATFORM_SPEC.md)                |
| [`telemetry.fuel_reading_usage`](../../docs/METHODOLOGY.md#telemetry.fuel_reading_usage) ⚠️ | `src/domain/fuel-aggregation.ts#addTotals`, `#totalFuelTon` — `FC_x = Σ r.fuel_x`, `FC = FC_ME + FC_AE` (t) | legacy MVP (`be-legacy/src/services/cii/cii.service.ts#calculateCII`, `src/models/ships/Telemetry.ts`), [platform spec §13.4](../../docs/PLATFORM_SPEC.md) |
| `telemetry.reading_validation` — _proposed id, not in the catalog yet_                      | `src/domain/fuel-reading.ts#readingViolations` — plausibility rules (≥ 0, maxima, skew, age, period)        | platform spec §13.4 (skew ≤ 5 min, batch ≤ 1000); the fuel maxima are v2 design defaults without an external source                                        |

The meaning of one reading (tonnes per interval vs. a cumulative counter) is not specified by the
legacy code and needs the device specification (catalog note of `telemetry.fuel_reading_usage`);
v2 treats a reading as the fuel burnt in the period ending at `time`.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
