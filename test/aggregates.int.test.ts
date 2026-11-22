import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  const [importedVessel, compressedVessel] = uniqueMmsis(2) as [number, number];

  /** Runs the refresh policy of a continuous aggregate now (as its schedule would). */
  const runRefreshPolicy = async (view: 'fuel_hourly' | 'fuel_daily') => {
    const { rows } = await service.pool.query<{ job_id: number }>(
      // jobs names the aggregate itself (TimescaleDB 2.32) or, in older
      // releases, its materialization hypertable.
      `SELECT j.job_id FROM timescaledb_information.jobs j
       JOIN timescaledb_information.continuous_aggregates c
         ON c.view_schema = 'telemetry' AND c.view_name = $1
       WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
         AND ((j.hypertable_schema = c.view_schema AND j.hypertable_name = c.view_name)
           OR (j.hypertable_schema = c.materialization_hypertable_schema
               AND j.hypertable_name = c.materialization_hypertable_name))`,
      [view],
    );
    expect(rows).toHaveLength(1);
    await service.pool.query('CALL run_job($1)', [rows[0]?.job_id]);
  };

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
    await runRefreshPolicy('fuel_hourly');
    await runRefreshPolicy('fuel_daily');

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

    await runRefreshPolicy('fuel_hourly');
    await runRefreshPolicy('fuel_daily');

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

    expect(
      (await post({ ...reading, fuelMeTon: 9 }, '?source=import')).json(),
    ).toEqual({
      received: 1,
      accepted: 0,
      duplicates: 1,
      published: 0,
    });
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
});
