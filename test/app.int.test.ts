import { randomUUID } from 'node:crypto';

import { runMigrations } from '@darmawanweb/ais-its-nest/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, SERVICE } from '../src/service.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

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
    expect(rows.map((row) => row.name)).toEqual([
      'init',
      'fuel_aggregates',
      'device_last_reading',
    ]);

    const hypertables = await service.pool.query<{
      hypertable_name: string;
      compression_enabled: boolean;
    }>(
      `SELECT hypertable_name, compression_enabled FROM timescaledb_information.hypertables
       WHERE hypertable_schema = 'telemetry' ORDER BY hypertable_name`,
    );
    expect(hypertables.rows).toContainEqual({
      hypertable_name: 'fuel_readings',
      compression_enabled: true,
    });

    const jobs = await service.pool.query<{
      proc_name: string;
      target: string;
    }>(
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
        {
          proc_name: 'policy_refresh_continuous_aggregate',
          target: 'fuel_hourly',
        },
        {
          proc_name: 'policy_refresh_continuous_aggregate',
          target: 'fuel_daily',
        },
      ]),
    );
  });

  it('converges when the no-transaction migration 0002 is retried after failing halfway', async () => {
    const recorded = async () =>
      (
        await service.pool.query<{ version: number; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version',
        )
      ).rows;
    const policies = async () =>
      (
        await service.pool.query<{ proc_name: string; target: string }>(
          `SELECT j.proc_name, coalesce(c.view_name, j.hypertable_name) AS target
           FROM timescaledb_information.jobs j
           LEFT JOIN timescaledb_information.continuous_aggregates c
             ON c.materialization_hypertable_name = j.hypertable_name
           WHERE j.proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')
             AND coalesce(c.view_schema, j.hypertable_schema) = 'telemetry'
           ORDER BY 1, 2`,
        )
      ).rows;
    const before = await recorded();
    const policiesBefore = await policies();

    // A first deployment that died after the fuel_hourly statements: its
    // view and policies exist, fuel_daily does not, 0002 is not recorded
    // (nor 0003, which never ran: the migrator applies versions in order).
    await service.pool.query(
      'DELETE FROM schema_migrations WHERE version IN (2, 3)',
    );
    await service.pool.query('DROP MATERIALIZED VIEW fuel_daily');

    const report = await runMigrations({
      pool: service.pool,
      schema: SERVICE.schema,
      dir: MIGRATIONS_DIR,
    });

    expect(report.applied.map((migration) => migration.version)).toEqual([
      2, 3,
    ]);
    expect(await recorded()).toEqual(before);
    // fuel_daily and its policy are back, nothing was created twice.
    expect(await policies()).toEqual(policiesBefore);
    expect(policiesBefore).toEqual([
      {
        proc_name: 'policy_refresh_continuous_aggregate',
        target: 'fuel_daily',
      },
      {
        proc_name: 'policy_refresh_continuous_aggregate',
        target: 'fuel_hourly',
      },
      { proc_name: 'policy_retention', target: 'fuel_hourly' },
      { proc_name: 'policy_retention', target: 'fuel_readings' },
    ]);
  });

  it('backfills lastReadingAt (0003) from the stored readings, and converges when retried', async () => {
    const { pool } = service;
    const [vessel, previous] = uniqueMmsis(2) as [number, number];
    const orgId = newOrgId();
    const ids = {
      reporting: randomUUID(),
      sharing: randomUUID(),
      silent: randomUUID(),
      moved: randomUUID(),
    };
    const at = (minutesAgo: number) =>
      new Date(Math.floor(Date.now() / 60_000) * 60_000 - minutesAgo * 60_000);
    // Devices as 0.1.0 left them: last_seen_at only. `sharing` reports on
    // the same vessel, its newest reading is behind newer ones of `reporting`;
    // `silent` never delivered; `moved` reported on its previous vessel.
    await pool.query(
      `INSERT INTO devices (id, org_id, mmsi, name, kind, last_seen_at) VALUES
         ($1, $5, $6, 'Reporting', 'mqtt', now()),
         ($2, $5, $6, 'Sharing', 'mqtt', now()),
         ($3, $5, $6, 'Silent', 'mqtt', NULL),
         ($4, $5, $6, 'Moved', 'mqtt', now())`,
      [ids.reporting, ids.sharing, ids.silent, ids.moved, orgId, vessel],
    );
    const readings: [Date, number, string][] = [
      [at(40), vessel, ids.reporting],
      [at(30), vessel, ids.sharing],
      [at(20), vessel, ids.reporting],
      [at(10), vessel, ids.reporting],
      [at(5), previous, ids.moved],
    ];
    for (const [time, mmsi, deviceId] of readings) {
      await pool.query(
        `INSERT INTO fuel_readings (time, mmsi, device_id, fuel_me_ton, fuel_ae_ton, source)
         VALUES ($1, $2, $3, 1, 0.1, 'mqtt')`,
        [time, mmsi, deviceId],
      );
    }
    const lastReadings = async () =>
      Object.fromEntries(
        (
          await pool.query<{ name: string; last_reading_at: Date | null }>(
            'SELECT name, last_reading_at FROM devices WHERE org_id = $1',
            [orgId],
          )
        ).rows.map((row) => [row.name, row.last_reading_at]),
      );
    const migrate = async () => {
      // A run that died after the ALTER TABLE: 0003 is not recorded.
      await pool.query('DELETE FROM schema_migrations WHERE version = 3');
      const report = await runMigrations({
        pool,
        schema: SERVICE.schema,
        dir: MIGRATIONS_DIR,
      });
      expect(report.applied.map((migration) => migration.version)).toEqual([3]);
    };

    await migrate();
    expect(await lastReadings()).toEqual({
      Reporting: at(10),
      Sharing: at(30),
      Silent: null,
      // Gets it with its next reading.
      Moved: null,
    });

    // Retried: rows that have a value keep it.
    await pool.query('UPDATE devices SET last_reading_at = $2 WHERE id = $1', [
      ids.reporting,
      at(1),
    ]);
    await migrate();
    expect((await lastReadings()).Reporting).toEqual(at(1));
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
    const body = response.json<{
      service: string;
      methods: { id: string; catalogued: boolean; status: string }[];
    }>();
    expect(body.service).toBe(SERVICE.name);
    // Every implemented id is catalogued (contracts 0.4 added reading_validation).
    expect(
      body.methods.map(({ id, catalogued, status }) => ({
        id,
        catalogued,
        status,
      })),
    ).toEqual(
      [
        'fuel.method_selection',
        'telemetry.fuel_reading_usage',
        'telemetry.reading_validation',
      ].map((id) => ({ id, catalogued: true, status: 'implemented' })),
    );
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
