import { setTimeout as sleep } from 'node:timers/promises';

import { testInfra, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  refreshAggregates,
  refreshPolicyOf,
  runRefreshPolicy,
  scheduleRefreshPolicies,
} from './support/aggregates.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Storage behaviour behind the queries: the refresh policies of the
 * continuous aggregates (run here as the scheduler would) and readings that
 * land in compressed chunks of the hypertable.
 */
describe('hypertable and continuous aggregates', () => {
  let service: TestService;
  let manager: { authorization: string };
  const orgId = newOrgId();
  const [importedVessel, compressedVessel, spreadVessel] = uniqueMmsis(3) as [
    number,
    number,
    number,
  ];

  const post = (body: object, query = '') =>
    service.app.inject({
      method: 'POST',
      url: `/api/v2/telemetry/readings${query}`,
      headers: manager,
      payload: body,
    });

  const get = (path: string) =>
    service.app.inject({
      method: 'GET',
      url: `/api/v2/telemetry/vessels/${path}`,
      headers: manager,
    });

  beforeAll(async () => {
    service = await startTestService();
    manager = await service.authorization({ roles: ['fleet_manager'], orgId });
    await service.publishVessel({ mmsi: importedVessel, orgId });
    await service.publishVessel({ mmsi: compressedVessel, orgId });
    await service.publishVessel({ mmsi: spreadVessel, orgId });
  });

  afterAll(async () => {
    await service.close();
  });

  it('folds historical imports into the hourly and daily aggregates at the next policy run', async () => {
    // A recent reading, materialized first: the watermark of both aggregates
    // moves past it, so the import below lands in the materialized region.
    const recent = await post({
      mmsi: importedVessel,
      time: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      fuelMeTon: 10,
      fuelAeTon: 1,
    });
    expect(recent.json()).toMatchObject({ accepted: 1 });
    await runRefreshPolicy(service.pool, 'fuel_hourly');
    await runRefreshPolicy(service.pool, 'fuel_daily');

    const day = Math.floor((Date.now() - 200 * DAY_MS) / DAY_MS) * DAY_MS;
    const at = (hours: number) => new Date(day + hours * HOUR_MS).toISOString();
    const imported = await post(
      [
        { mmsi: importedVessel, time: at(10), fuelMeTon: 1, fuelAeTon: 0.5 },
        { mmsi: importedVessel, time: at(10.5), fuelMeTon: 2, fuelAeTon: 0.5 },
        { mmsi: importedVessel, time: at(11.25), fuelMeTon: 4, fuelAeTon: 0.5 },
      ],
      '?source=import',
    );
    expect(imported.json()).toMatchObject({ accepted: 3 });

    await runRefreshPolicy(service.pool, 'fuel_hourly');
    await runRefreshPolicy(service.pool, 'fuel_daily');

    const range = `from=${at(0)}&to=${at(24)}`;
    const series = async (bucket: string) =>
      (await get(`${importedVessel}/readings?${range}&bucket=${bucket}`))
        .json<{
          data: { time: string; fuelMeTon: number; readings: number }[];
        }>()
        .data.map(({ time, fuelMeTon, readings }) => ({
          time,
          fuelMeTon,
          readings,
        }));
    expect(await series('1h')).toEqual([
      { time: at(10), fuelMeTon: 3, readings: 2 },
      { time: at(11), fuelMeTon: 4, readings: 1 },
    ]);
    expect(await series('1d')).toEqual([
      { time: at(0), fuelMeTon: 7, readings: 3 },
    ]);

    // A whole day comes from fuel_daily, an hour-aligned range from fuel_hourly.
    expect(
      (await get(`${importedVessel}/summary?${range}`)).json(),
    ).toMatchObject({
      readings: 3,
      fuelMeTon: 7,
      fuelAeTon: 1.5,
      totalFuelTon: 8.5,
      firstReadingAt: at(10),
      lastReadingAt: at(11.25),
    });
    expect(
      (
        await get(`${importedVessel}/summary?from=${at(10.25)}&to=${at(12)}`)
      ).json(),
    ).toMatchObject({
      readings: 2,
      fuelMeTon: 6,
    });
  });

  it('stores each UTC day of a request in its own transaction: refreshes re-aggregate those days only', async () => {
    // Two readings 5 days apart in one 7-day chunk (chunks start at multiples
    // of 7 days since the Unix epoch), far from the other tests' data.
    const week = 7 * DAY_MS;
    const chunkStart = Math.floor((Date.now() - 700 * DAY_MS) / week) * week;
    const first = new Date(chunkStart + DAY_MS + 3 * HOUR_MS);
    const last = new Date(chunkStart + 6 * DAY_MS + 20 * HOUR_MS);
    /** Invalidation ranges logged for fuel_readings within [first, last] (TimescaleDB catalog, µs since the epoch). */
    const invalidations = async () =>
      (
        await service.pool.query<{ lowest: string; greatest: string }>(
          `SELECT l.lowest_modified_value::text AS lowest, l.greatest_modified_value::text AS greatest
           FROM _timescaledb_catalog.continuous_aggs_hypertable_invalidation_log l
           JOIN _timescaledb_catalog.hypertable h ON h.id = l.hypertable_id
           WHERE h.schema_name = 'telemetry' AND h.table_name = 'fuel_readings'
             AND l.greatest_modified_value >= $1 AND l.lowest_modified_value <= $2
           ORDER BY l.lowest_modified_value`,
          [first.getTime() * 1000, last.getTime() * 1000],
        )
      ).rows.map(({ lowest, greatest }) => [
        new Date(Number(BigInt(lowest) / 1000n)).toISOString(),
        new Date(Number(BigInt(greatest) / 1000n)).toISOString(),
      ]);

    // Invalidations are logged below the materialization threshold (set by a
    // refresh); no policy run may consume the log before the check.
    await runRefreshPolicy(service.pool, 'fuel_hourly');
    await scheduleRefreshPolicies(service.pool, false);
    try {
      const response = await post(
        [
          {
            mmsi: spreadVessel,
            time: first.toISOString(),
            fuelMeTon: 1,
            fuelAeTon: 0,
          },
          {
            mmsi: spreadVessel,
            time: last.toISOString(),
            fuelMeTon: 1,
            fuelAeTon: 0,
          },
        ],
        '?source=import',
      );
      expect(response.json()).toMatchObject({ accepted: 2 });

      // One transaction would have logged [first, last]: 5 days of every vessel.
      expect(await invalidations()).toEqual([
        [first.toISOString(), first.toISOString()],
        [last.toISOString(), last.toISOString()],
      ]);
    } finally {
      await scheduleRefreshPolicies(service.pool, true);
    }
  });

  it('keeps readings of compressed chunks idempotent and accepts new ones there', async () => {
    // 10:00 UTC of a day 300 days ago: the reading an hour later is in the same 7-day chunk.
    const time = new Date(
      Math.floor((Date.now() - 300 * DAY_MS) / DAY_MS) * DAY_MS + 10 * HOUR_MS,
    );
    const reading = {
      mmsi: compressedVessel,
      time: time.toISOString(),
      fuelMeTon: 5,
      fuelAeTon: 1,
    };
    expect((await post(reading, '?source=import')).json()).toMatchObject({
      accepted: 1,
      published: 1,
    });

    await service.pool.query(
      `SELECT compress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, if_not_compressed => true)
       FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'telemetry' AND hypertable_name = 'fuel_readings'
         AND range_start <= $1 AND range_end > $1`,
      [time.toISOString()],
    );
    const { rows: chunks } = await service.pool.query<{
      is_compressed: boolean;
    }>(
      `SELECT is_compressed FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'telemetry' AND hypertable_name = 'fuel_readings'
         AND range_start <= $1 AND range_end > $1`,
      [time.toISOString()],
    );
    expect(chunks).toEqual([{ is_compressed: true }]);

    // Repeats are compared with the stored reading inside the compressed chunk.
    expect((await post(reading, '?source=import')).json()).toEqual({
      received: 1,
      accepted: 0,
      duplicates: 1,
      published: 0,
    });
    const conflict = await post({ ...reading, fuelMeTon: 9 }, '?source=import');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'READING_CONFLICT' });
    const later = {
      ...reading,
      time: new Date(time.getTime() + HOUR_MS).toISOString(),
    };
    expect((await post(later, '?source=import')).json()).toMatchObject({
      accepted: 1,
      published: 1,
    });

    const raw = await get(
      `${compressedVessel}/readings?from=${time.toISOString()}&to=${new Date(time.getTime() + 2 * HOUR_MS).toISOString()}`,
    );
    expect(
      raw
        .json<{ data: { fuelMeTon: number; source: string }[] }>()
        .data.map(({ fuelMeTon, source }) => ({
          fuelMeTon,
          source,
        })),
    ).toEqual([
      { fuelMeTon: 5, source: 'import' },
      { fuelMeTon: 5, source: 'import' },
    ]);
  });

  it('refreshes both aggregates while a refresh of them is in progress, with the policies paused meanwhile', async () => {
    // A policy run in progress, as TimescaleDB registers it: the window of
    // fuel_daily held by a live backend (the admin connection). Overlapping
    // refreshes are refused with 55P03 until it ends.
    const admin = new Client({
      connectionString: testInfra('postgres').postgres.adminUrl,
    });
    await admin.connect();
    const daily = await refreshPolicyOf(service.pool, 'fuel_daily');
    const hourly = await refreshPolicyOf(service.pool, 'fuel_hourly');
    const endRun = () =>
      admin.query(
        `DELETE FROM _timescaledb_catalog.continuous_aggs_jobs_refresh_ranges
         WHERE pid = pg_backend_pid()`,
      );
    try {
      await admin.query(
        `INSERT INTO _timescaledb_catalog.continuous_aggs_jobs_refresh_ranges
           (materialization_id, start_range, end_range, pid, job_id, created_at)
         SELECT mat_hypertable_id, -9223372036854775808, 9223372036854775807,
                pg_backend_pid(), $1, now()
         FROM _timescaledb_catalog.continuous_agg
         WHERE user_view_schema = 'telemetry' AND user_view_name = 'fuel_daily'`,
        [daily.jobId],
      );
      // What the plain CALL of readings.int.test.ts ran into.
      await expect(
        service.pool.query(
          `CALL refresh_continuous_aggregate('fuel_daily', NULL, NULL)`,
        ),
      ).rejects.toMatchObject({ code: '55P03' });

      // A paused schedule stays paused, a running one runs again afterwards.
      await scheduleRefreshPolicies(service.pool, true);
      await service.pool.query('SELECT alter_job($1, scheduled => false)', [
        hourly.jobId,
      ]);
      const refreshedAt = refreshAggregates(service.pool).then(() =>
        Date.now(),
      );
      await waitFor(
        async () =>
          !(await refreshPolicyOf(service.pool, 'fuel_daily')).scheduled,
      );
      // Refused meanwhile; the run ends a moment later and the refresh follows.
      await sleep(300);
      const endedAt = Date.now();
      await endRun();
      expect(await refreshedAt).toBeGreaterThanOrEqual(endedAt);
      expect(
        (await refreshPolicyOf(service.pool, 'fuel_daily')).scheduled,
      ).toBe(true);
      expect(
        (await refreshPolicyOf(service.pool, 'fuel_hourly')).scheduled,
      ).toBe(false);
    } finally {
      await endRun();
      await admin.end();
      await scheduleRefreshPolicies(service.pool, true);
    }
  });
});
