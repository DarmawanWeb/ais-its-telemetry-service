import {
  provisionServiceSchema,
  startTestInfra,
} from '@darmawanweb/ais-its-nest/testing';
import type { TestProject } from 'vitest/node';

import { SERVICE } from '../../src/service.js';

/**
 * Starts TimescaleDB/PostGIS and NATS once for all integration test files,
 * provisions the service schema and role like `infra/postgres/bootstrap.sql`
 * and provides the endpoints (`inject('infra')`).
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // `test.env` does not reach the main process that runs this setup.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const infra = await startTestInfra({ postgres: true, nats: true });
  try {
    const databaseUrl = await provisionServiceSchema(
      infra.postgres.adminUrl,
      SERVICE.schema,
    );
    project.provide('infra', { databaseUrl, natsUrl: infra.nats.url });
  } catch (error) {
    await infra.stop();
    throw error;
  }
  return () => infra.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    infra: {
      /** `DATABASE_URL` of the service role. */
      databaseUrl: string;
      natsUrl: string;
    };
  }
}
