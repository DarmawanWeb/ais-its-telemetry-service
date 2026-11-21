import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from '../src/service.js';
import { startTestService, type TestService } from './support/test-service.js';

const METHODOLOGY_URL = `/api/v2/${SERVICE.name}/methodology`;

describe(`${SERVICE.packageName} platform behaviour`, () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.close();
  });

  it('is live and ready with the database and NATS up', async () => {
    const live = await service.app.inject({
      method: 'GET',
      url: '/health/live',
    });
    expect(live.statusCode).toBe(200);

    const ready = await service.app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      details: { database: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('applied the migrations to its own schema', async () => {
    const { rows } = await service.pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((row) => row.name)).toEqual(['init', 'fuel_aggregates']);

    const hypertables = await service.pool.query<{ hypertable_name: string; compression_enabled: boolean }>(
      `SELECT hypertable_name, compression_enabled FROM timescaledb_information.hypertables
       WHERE hypertable_schema = 'telemetry' ORDER BY hypertable_name`,
    );
    expect(hypertables.rows).toContainEqual({ hypertable_name: 'fuel_readings', compression_enabled: true });

    const jobs = await service.pool.query<{ proc_name: string; target: string }>(
      `SELECT j.proc_name, coalesce(c.view_name, j.hypertable_name) AS target
       FROM timescaledb_information.jobs j
       LEFT JOIN timescaledb_information.continuous_aggregates c
         ON c.materialization_hypertable_name = j.hypertable_name
       WHERE j.hypertable_schema IN ('telemetry', '_timescaledb_internal')
         AND j.proc_name IN ('policy_compression', 'policy_retention', 'policy_refresh_continuous_aggregate')
       ORDER BY 1, 2`,
    );
    expect(jobs.rows).toEqual(
      expect.arrayContaining([
        { proc_name: 'policy_compression', target: 'fuel_readings' },
        { proc_name: 'policy_retention', target: 'fuel_readings' },
        { proc_name: 'policy_refresh_continuous_aggregate', target: 'fuel_hourly' },
        { proc_name: 'policy_refresh_continuous_aggregate', target: 'fuel_daily' },
      ]),
    );
  });

  it('denies anonymous requests with 401 problem details', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: METHODOLOGY_URL,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['www-authenticate']).toBeDefined();
  });

  it('serves the methodology to a signed-in user', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: METHODOLOGY_URL,
      headers: await service.authorization({ roles: ['viewer'] }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: SERVICE.name });
  });

  it('documents its routes in /openapi.json', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: '/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(document.paths)).toContain(METHODOLOGY_URL);
  });

  it('exposes Prometheus metrics', async () => {
    const response = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('aisits_http_requests_total');
  });
});
