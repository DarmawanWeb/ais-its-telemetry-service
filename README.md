# ais-its-telemetry-service

Fuel consumption telemetry: readings ingest over REST and MQTT, device registry, queries and status; publishes fuel.reading.recorded.v1

Service `telemetry` of **AIS Maritime Intelligence** v2: NestJS 12 + Fastify on the platform
kit [`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest),
PostgreSQL schema `telemetry` (TimescaleDB + PostGIS), NATS JetStream. The normative engineering
spec is `docs/PLATFORM_SPEC.md` in the central repository
([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose

<!-- TODO: what the service is responsible for, what it owns and what it does not do. -->

- Owns the PostgreSQL schema `telemetry`; other services reach its data through its API or its events.

## Architecture

```text
HTTP :3005 (/api/v2/telemetry/…)
  │  global default-deny guard (JWT from auth, API keys only on @AllowApiKey routes)
  ▼
src/modules/<feature>/   controller → service → repository (drizzle) ──► PostgreSQL schema "telemetry"
audit.v1.telemetry ◄── AuditService (every write)
```

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
restore state and start consumers (`onApplicationBootstrap`) → the port opens. On `SIGTERM`
readiness turns `503`, consumers drain, NATS drains and the pool closes.

| Path                     | What                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `src/main.ts`            | starts tracing, then the server (`src/server.ts`)                  |
| `src/app.module.ts`      | root module (database, NATS, auth, features)                       |
| `src/config.ts`          | zod environment schema extending the kit's base schema             |
| `src/service.ts`         | service identity (name, schema, port, version from `package.json`) |
| `src/db/schema.ts`       | drizzle definitions mirroring `migrations/*.sql`                   |
| `src/modules/<feature>/` | controller, service, repository, DTOs, unit tests                  |
| `src/domain/`            | pure functions (formulas, rules) with `@method` TSDoc              |
| `migrations/`            | forward-only SQL migrations `NNNN_snake_case.sql`                  |
| `test/`                  | integration tests `*.int.test.ts` (testcontainers)                 |

## Getting started

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` packages
come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env
pnpm --dir <central repo> infra:up     # postgres, nats, valkey, … (or any reachable instances)
pnpm dev                               # watch mode (SWC, decorator metadata)
curl -s localhost:3005/health/ready
open http://localhost:3005/docs    # Swagger UI
```

| Script                                         | What                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev`                                     | watch mode (`nest start --watch --builder swc`)                                             |
| `pnpm build` / `pnpm start`                    | compile with `tsc` to `dist/` / run it                                                      |
| `pnpm start:prod`                              | run `dist/` with `NODE_ENV=production`                                                      |
| `pnpm migrate`                                 | apply `migrations/` (also on boot when `DB_MIGRATE_ON_BOOT=true`)                           |
| `pnpm openapi`                                 | build, then write `openapi.json` without any infrastructure (commit it)                     |
| `pnpm openapi:check`                           | fail when the committed `openapi.json` differs from `dist/` (CI)                            |
| `pnpm test`                                    | unit tests (`src/**/*.spec.ts`), no Docker needed                                           |
| `pnpm test:int`                                | integration tests (`test/**/*.int.test.ts`) against TimescaleDB/PostGIS and NATS containers |
| `pnpm test:all`                                | both                                                                                        |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc --noEmit`, Prettier                                                            |

## Configuration

Every variable is listed with its development default in [`.env.example`](.env.example); the
service refuses to start on invalid values and prints every problem.

| Variable                      | Default                                                        | Notes                                               |
| ----------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `SERVICE_NAME`                | `telemetry`                                                    | logs, metrics, event `source`, `audit.v1.<service>` |
| `PORT`                        | `3005`                                                         | spec §3                                             |
| `DATABASE_URL`                | `postgres://telemetry_svc:telemetry_svc@localhost:5432/aisits` | required in production                              |
| `DATABASE_SCHEMA`             | `telemetry`                                                    | `search_path=telemetry,public`                      |
| `NATS_URL`                    | `nats://localhost:4222`                                        | comma separated list allowed                        |
| `AUTH_JWKS_URL`               | `http://localhost:3001/.well-known/jwks.json`                  | access tokens are verified locally                  |
| `INTERNAL_TOKEN`              | `dev-internal-token-change-me`                                 | ≥ 16 characters in production                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset                                                          | tracing when set                                    |

The remaining platform variables (`LOG_LEVEL`, `DATABASE_POOL_MAX`, `CORS_ORIGINS`, …) are
described in spec §4.

## API

Routes live under `/api/v2` (OpenAPI: `/docs`, `/openapi.json`, committed as
[`openapi.json`](openapi.json)); errors are RFC 9457 problem details. Outside the prefix:
`/health/live`, `/health/ready`, `/metrics`.

| Method and path                                                   | Permission         | What                                                 |
| ----------------------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| `GET /api/v2/telemetry/methodology`                               | any signed-in user | methods implemented here and their sources           |
| `GET /api/v2/telemetry/notes?mmsi&tag&search&orgId&page&pageSize` | `vessel:read`      | notes of the active organization (example)           |
| `GET /api/v2/telemetry/notes/:id`                                 | `vessel:read`      | one note                                             |
| `POST /api/v2/telemetry/notes`                                    | `vessel:write`     | create (`409 NOTE_TITLE_TAKEN` on a duplicate title) |
| `PATCH /api/v2/telemetry/notes/:id`                               | `vessel:write`     | change title, body or tags                           |
| `DELETE /api/v2/telemetry/notes/:id`                              | `vessel:write`     | delete                                               |

## Events

| Direction | Stream / subject               | Type                | Notes                     |
| --------- | ------------------------------ | ------------------- | ------------------------- |
| produces  | `AUDIT` / `audit.v1.telemetry` | `audit.recorded.v1` | every write (best effort) |

<!-- TODO: list every stream, subject and event type the service produces or consumes. -->

## Data

Schema `telemetry`, owned by `telemetry_svc`; migrations in [`migrations/`](migrations) are
forward-only and checksummed (never edit an applied file — add `NNNN_<change>.sql`).

- `notes` — vessel notes of an organization (example).

<!-- TODO: describe the tables, hypertables, retention and compression policies. -->

## Methodology & references

Every formula, constant, threshold and rule is traceable to its source (spec §17): the
implementing function carries a `@method <id>` TSDoc tag, the id is listed in
[`src/modules/methodology/implemented-methods.ts`](src/modules/methodology/implemented-methods.ts)
(served by `GET /api/v2/telemetry/methodology`) and described in the central catalog
`docs/references/methods.json` and `docs/METHODOLOGY.md`.

| Method id                | Implemented by                          | Status                            |
| ------------------------ | --------------------------------------- | --------------------------------- |
| `geo.eta_constant_speed` | `src/domain/arrival.ts#estimateArrival` | example — catalog it or delete it |

<!-- TODO: one row per method; values without a verified source are marked needsCitation in the catalog. -->

## Testing

- Unit tests next to the code (`*.spec.ts`), formulas with golden values (legacy parity where a
  legacy implementation exists).
- Integration tests in `test/*.int.test.ts` boot the real `AppModule` against containers started
  once by `test/support/global-setup.ts` (`timescale/timescaledb-ha:pg17`, `nats:2.11-alpine`),
  with access tokens from the kit's test issuer.

## Operations

- Image `ghcr.io/darmawanweb/ais-its-telemetry-service` (CI pushes `main` and `sha-<commit>`, releases push
  `<version>`, `<major>.<minor>` and `latest`). Local build:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-telemetry-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-telemetry-service .
  ```

  `.pnpmfile.cjs` keeps compile-time-only optional peers (TypeScript for the Swagger CLI plugin)
  out of the production install.

- Non-root (`node`), `NODE_ENV=production`, `HEALTHCHECK` on `/health/live`, readiness on
  `/health/ready` (database, NATS), Prometheus metrics on `/metrics` (`aisits_*`).
- Release: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new version,
  bump `package.json`, tag `v<version>`.

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
