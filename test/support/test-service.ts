import { randomInt, randomUUID } from 'node:crypto';

import type { ApiKeyScope } from '@darmawanweb/ais-its-contracts/auth';
import {
  EVENT_TYPES,
  type VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { makeTestVesselSnapshot } from '@darmawanweb/ais-its-nest/analytics';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { PG_POOL } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type FakeIntrospectionServer,
  generateTestApiKey,
  type ProviderOverride,
  startFakeApiKeyIntrospection,
  type TestJwtIssuer,
  type TestTokenClaims,
  uniqueName,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';

/** `X-Internal-Token` shared by the service and the fake introspection. */
const INTERNAL_TOKEN = 'test-internal-token-0123456789';

/** An API key known to the fake introspection endpoint. */
export interface TestApiKey {
  readonly keyId: string;
  readonly orgId: string;
  /** Request headers carrying the key. */
  readonly headers: { readonly 'x-api-key': string };
}

/** The real application on the shared containers, with test credentials. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  readonly introspection: FakeIntrospectionServer;
  /** The service's pool (search_path = telemetry). */
  readonly pool: Pool;
  /** `Authorization` header with a freshly signed access token. */
  authorization(claims?: TestTokenClaims): Promise<{ authorization: string }>;
  /** Registers an API key of `orgId` (default scope `telemetry:ingest`). */
  apiKey(orgId: string, scopes?: readonly ApiKeyScope[]): TestApiKey;
  /** Publishes a FLEET snapshot like the fleet service and waits for the projection. */
  publishVessel(
    overrides: Partial<VesselSnapshotV1> & Pick<VesselSnapshotV1, 'mmsi'>,
  ): Promise<VesselSnapshotV1>;
  close(): Promise<void>;
}

/** Options of {@link startTestService}. */
export interface TestServiceOptions {
  /** Environment overrides (strings, as in `.env`). */
  readonly env?: Readonly<Record<string, string>>;
  /** NATS of this application (default: the shared test NATS). */
  readonly natsUrl?: string;
  readonly overrides?: readonly ProviderOverride[];
}

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams, consumers, the MQTT subscription and the
 * relay start) without listening; use `app.inject()`. Durable consumers get
 * a unique prefix per application so that test files never share them.
 */
export async function startTestService(
  options: TestServiceOptions = {},
): Promise<TestService> {
  const infra = inject('infra');
  const jwt = await createTestJwtIssuer();
  const introspection = await startFakeApiKeyIntrospection({
    internalToken: INTERNAL_TOKEN,
  });
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: options.natsUrl ?? infra.natsUrl,
    NATS_DURABLE_PREFIX: uniqueName('t'),
    AUTH_INTERNAL_URL: introspection.url,
    INTERNAL_TOKEN,
    ...options.env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
      ...(options.overrides ?? []),
    ],
  }).catch(async (error: unknown) => {
    await introspection.close();
    throw error;
  });
  const pool = app.get<unknown, Pool>(PG_POOL);

  return {
    app,
    config,
    jwt,
    introspection,
    pool,
    authorization: async (claims) => ({
      authorization: `Bearer ${await jwt.sign(claims)}`,
    }),
    apiKey: (orgId, scopes = ['telemetry:ingest']) => {
      const key = generateTestApiKey();
      const { keyId } = introspection.introspector.add(key, {
        orgId,
        scopes,
        keyId: randomUUID(),
      });
      return { keyId, orgId, headers: { 'x-api-key': key } };
    },
    publishVessel: async (overrides) => {
      const snapshot = makeTestVesselSnapshot({
        updatedAt: new Date().toISOString(),
        ...overrides,
      });
      await app
        .get(EventPublisher)
        .publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot);
      await waitFor(
        async () =>
          (
            await pool.query(
              'SELECT 1 FROM vessels WHERE mmsi = $1 AND vessel_id = $2 AND source_updated_at = $3',
              [snapshot.mmsi, snapshot.id, snapshot.updatedAt],
            )
          ).rowCount === 1,
        { timeoutMs: 15_000, message: `vessel ${snapshot.mmsi} not projected` },
      );
      return snapshot;
    },
    close: async () => {
      await app.close();
      await introspection.close();
    },
  };
}

/**
 * `count` consecutive MMSIs from a random block, so that test files sharing
 * the database never collide.
 */
export function uniqueMmsis(count: number): number[] {
  const base = randomInt(200_000, 999_000) * 1000;
  return Array.from({ length: count }, (_, index) => base + index);
}

/** A new organization id. */
export function newOrgId(): string {
  return randomUUID();
}
