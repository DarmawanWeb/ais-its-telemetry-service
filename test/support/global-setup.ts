import {
  provisionServiceSchema,
  testInfra,
  testInfraGlobalSetup,
} from '@darmawanweb/ais-its-nest/testing';
import type { TestProject } from 'vitest/node';

import { SERVICE } from '../../src/service.js';

/**
 * TimescaleDB/PostGIS and NATS with JetStream and the MQTT gateway (as the
 * platform's compose `nats` service) for all integration test files, started
 * once; files read the endpoints with `testInfra('nats')`.
 */
const startInfra = testInfraGlobalSetup({
  postgres: true,
  nats: { mqtt: true },
});

/**
 * Starts the shared containers, provisions the service schema and role like
 * `infra/postgres/bootstrap.sql` and provides the service's `DATABASE_URL`
 * (`inject('databaseUrl')`).
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // `test.env` does not reach the main process that runs this setup.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const teardown = await startInfra();
  try {
    const { postgres } = testInfra('postgres');
    project.provide(
      'databaseUrl',
      await provisionServiceSchema(postgres.adminUrl, SERVICE.schema),
    );
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** `DATABASE_URL` of the service role `telemetry_svc`. */
    databaseUrl: string;
  }
}
