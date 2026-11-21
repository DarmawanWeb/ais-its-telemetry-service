import { EVENT_TYPES, subjects } from '@darmawanweb/ais-its-contracts/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFuelEvents } from './support/fuel-events.js';
import {
  newOrgId,
  startTestService,
  type TestApiKey,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

const READINGS_URL = '/api/v2/telemetry/readings';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

describe('fuel readings over REST', () => {
  let service: TestService;
  const orgA = newOrgId();
  const orgB = newOrgId();
  const [vesselA1, vesselA2, vesselB1, unknownVessel, queryVessel] = uniqueMmsis(5) as [
    number,
    number,
    number,
    number,
    number,
  ];
  let keyA: TestApiKey;
  const now = Date.now();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  const post = async (body: unknown, headers: Record<string, string>, query = '') =>
    service.app.inject({ method: 'POST', url: `${READINGS_URL}${query}`, headers, payload: body as object });

  beforeAll(async () => {
    service = await startTestService();
    keyA = service.apiKey(orgA);
    await service.publishVessel({ mmsi: vesselA1, orgId: orgA, name: 'KM Alpha' });
    await service.publishVessel({ mmsi: vesselA2, orgId: orgA, name: 'KM Bravo' });
    await service.publishVessel({ mmsi: vesselB1, orgId: orgB, name: 'KM Charlie' });
    await service.publishVessel({ mmsi: queryVessel, orgId: orgA, name: 'KM Query' });
  });

  afterAll(async () => {
    await service.close();
  });

  describe('POST /telemetry/readings with an API key (telemetry:ingest)', () => {
    it('stores a batch, answers 202 and publishes fuel.reading.recorded.v1 per reading', async () => {
      const batch = [
        { mmsi: vesselA1, time: minutesAgo(3), fuelMeTon: 0.4, fuelAeTon: 0.05 },
        { mmsi: vesselA1, time: minutesAgo(2), periodStart: minutesAgo(3), fuelMeTon: 0.5, fuelAeTon: 0.06 },
      ];

      const response = await post(batch, keyA.headers);

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ received: 2, accepted: 2, duplicates: 0, published: 2 });

      const { rows } = await service.pool.query<{ source: string; published: boolean; queued: boolean }>(
        `SELECT r.source, r.published_at IS NOT NULL AS published,
                EXISTS (SELECT 1 FROM fuel_readings_unpublished u WHERE u.mmsi = r.mmsi AND u.time = r.time) AS queued
         FROM fuel_readings r WHERE r.mmsi = $1 ORDER BY r.time`,
        [vesselA1],
      );
      expect(rows).toEqual([
        { source: 'api', published: true, queued: false },
        { source: 'api', published: true, queued: false },
      ]);

      const events = await readFuelEvents(service.app, vesselA1, 2);
      expect(events.map((event) => event.subject)).toEqual([
        subjects.fuelReading(vesselA1),
        subjects.fuelReading(vesselA1),
      ]);
      expect(events.map((event) => event.msgId)).toEqual(
        batch.map((reading) => `${vesselA1}:${new Date(reading.time).toISOString()}`),
      );
      expect(events[1]?.envelope).toMatchObject({
        type: EVENT_TYPES.FUEL_READING_RECORDED,
        source: 'telemetry',
        data: {
          mmsi: vesselA1,
          time: new Date(batch[1]?.time ?? '').toISOString(),
          periodStart: new Date(batch[1]?.periodStart ?? '').toISOString(),
          fuelMeTon: 0.5,
          fuelAeTon: 0.06,
          deviceId: null,
          source: 'api',
        },
      });
    });

    it('accepts a single reading object', async () => {
      const response = await post({ mmsi: vesselA2, time: minutesAgo(1), fuelMeTon: 1, fuelAeTon: 0.1 }, keyA.headers);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ received: 1, accepted: 1 });
    });

    it('is idempotent by (mmsi, time): stored and repeated readings count as duplicates', async () => {
      const reading = { mmsi: vesselA2, time: minutesAgo(30), fuelMeTon: 2, fuelAeTon: 0.2 };
      expect((await post([reading, reading], keyA.headers)).json()).toMatchObject({
        received: 2,
        accepted: 1,
        duplicates: 1,
      });
      expect((await post([reading, { ...reading, fuelMeTon: 9 }], keyA.headers)).json()).toEqual({
        received: 2,
        accepted: 0,
        duplicates: 2,
        published: 0,
      });
      const { rows } = await service.pool.query<{ fuel_me_ton: number }>(
        'SELECT fuel_me_ton FROM fuel_readings WHERE mmsi = $1 AND time = $2',
        [vesselA2, reading.time],
      );
      expect(rows).toEqual([{ fuel_me_ton: 2 }]);
      expect(await readFuelEvents(service.app, vesselA2, 3, 1500)).toHaveLength(2);
    });

    it('rejects implausible readings with 400 and <index>.<field> errors, storing nothing', async () => {
      const response = await post(
        [
          { mmsi: vesselA1, time: minutesAgo(50), fuelMeTon: 0.4, fuelAeTon: 0.05 },
          { mmsi: vesselA1, time: new Date(now + 10 * 60_000).toISOString(), fuelMeTon: -1, fuelAeTon: 0 },
          { mmsi: vesselA1, time: minutesAgo(40), fuelMeTon: 900, fuelAeTon: 0, extra: true },
        ],
        keyA.headers,
      );

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const problem = response.json<{ code: string; errors: { field: string }[] }>();
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors.map((error) => error.field)).toEqual(['1.fuelMeTon', '2.extra']);

      const retried = await post(
        [
          { mmsi: vesselA1, time: new Date(now + 10 * 60_000).toISOString(), fuelMeTon: 1, fuelAeTon: 0 },
          { mmsi: vesselA1, time: minutesAgo(40), fuelMeTon: 900, fuelAeTon: 0 },
        ],
        keyA.headers,
      );
      expect(retried.json<{ errors: { field: string; code: string }[] }>().errors).toEqual([
        expect.objectContaining({ field: '0.time', code: 'future_time' }),
        expect.objectContaining({ field: '1.fuelMeTon', code: 'above_maximum' }),
      ]);
      const { rows } = await service.pool.query('SELECT 1 FROM fuel_readings WHERE mmsi = $1 AND time = $2', [
        vesselA1,
        minutesAgo(50),
      ]);
      expect(rows).toHaveLength(0);
    });

    it('rejects unknown vessels with 404 VESSEL_NOT_FOUND and other organizations with 403', async () => {
      const unknown = await post(
        [
          { mmsi: vesselA1, time: minutesAgo(5), fuelMeTon: 1, fuelAeTon: 0 },
          { mmsi: unknownVessel, time: minutesAgo(5), fuelMeTon: 1, fuelAeTon: 0 },
        ],
        keyA.headers,
      );
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'VESSEL_NOT_FOUND', mmsi: unknownVessel });

      const foreign = await post({ mmsi: vesselB1, time: minutesAgo(5), fuelMeTon: 1, fuelAeTon: 0 }, keyA.headers);
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toMatchObject({ code: 'FORBIDDEN', mmsi: [vesselB1] });

      const { rows } = await service.pool.query('SELECT 1 FROM fuel_readings WHERE time = $1', [minutesAgo(5)]);
      expect(rows).toHaveLength(0);
    });

    it('requires the telemetry:ingest scope', async () => {
      const aisKey = service.apiKey(orgA, ['ais:ingest']);
      const response = await post({ mmsi: vesselA1, time: minutesAgo(7), fuelMeTon: 1, fuelAeTon: 0 }, aisKey.headers);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    });

    it('refuses a source chosen by an API key', async () => {
      const response = await post({ mmsi: vesselA1, time: minutesAgo(8), fuelMeTon: 1, fuelAeTon: 0 }, keyA.headers, '?source=import');
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /telemetry/readings with a user token (telemetry:write)', () => {
    it('stores manual entries and historical imports of the active organization', async () => {
      const manager = await service.authorization({ roles: ['fleet_manager'], orgId: orgA });
      expect((await post({ mmsi: vesselA2, time: minutesAgo(90), fuelMeTon: 3, fuelAeTon: 0.3 }, manager)).statusCode).toBe(202);
      const imported = await post(
        { mmsi: vesselA2, time: new Date(now - 400 * DAY_MS).toISOString(), fuelMeTon: 30, fuelAeTon: 3 },
        manager,
        '?source=import',
      );
      expect(imported.statusCode).toBe(202);

      const { rows } = await service.pool.query<{ source: string }>(
        'SELECT source FROM fuel_readings WHERE mmsi = $1 AND time IN ($2, $3) ORDER BY time',
        [vesselA2, new Date(now - 400 * DAY_MS).toISOString(), minutesAgo(90)],
      );
      expect(rows.map((row) => row.source)).toEqual(['import', 'manual']);
    });

    it('needs telemetry:write and the vessel of the active organization', async () => {
      const viewer = await service.authorization({ roles: ['viewer'], orgId: orgA });
      expect((await post({ mmsi: vesselA1, time: minutesAgo(9), fuelMeTon: 1, fuelAeTon: 0 }, viewer)).statusCode).toBe(403);

      const adminB = await service.authorization({ roles: ['org_admin'], orgId: orgB });
      const response = await post({ mmsi: vesselA1, time: minutesAgo(9), fuelMeTon: 1, fuelAeTon: 0 }, adminB);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('denies anonymous requests', async () => {
      expect((await post({ mmsi: vesselA1, time: minutesAgo(9), fuelMeTon: 1, fuelAeTon: 0 }, {})).statusCode).toBe(401);
    });
  });

  describe('readings of a device key', () => {
    it('attributes them to the device and enforces its vessel and status', async () => {
      const admin = await service.authorization({ roles: ['org_admin'], orgId: orgA });
      const deviceKey = service.apiKey(orgA);
      const created = await service.app.inject({
        method: 'POST',
        url: '/api/v2/telemetry/devices',
        headers: admin,
        payload: { mmsi: vesselA1, name: 'ME flow meter (http)', kind: 'http', apiKeyId: deviceKey.keyId },
      });
      expect(created.statusCode).toBe(201);
      const device = created.json<{ id: string }>();

      expect((await post({ mmsi: vesselA1, time: minutesAgo(11), fuelMeTon: 1, fuelAeTon: 0.1 }, deviceKey.headers)).statusCode).toBe(202);
      const { rows } = await service.pool.query<{ source: string; device_id: string }>(
        'SELECT source, device_id FROM fuel_readings WHERE mmsi = $1 AND time = $2',
        [vesselA1, minutesAgo(11)],
      );
      expect(rows).toEqual([{ source: 'device', device_id: device.id }]);
      const seen = await service.app.inject({ method: 'GET', url: `/api/v2/telemetry/devices/${device.id}`, headers: admin });
      expect(seen.json<{ lastSeenAt: string | null }>().lastSeenAt).not.toBeNull();

      const mismatch = await post({ mmsi: vesselA2, time: minutesAgo(12), fuelMeTon: 1, fuelAeTon: 0 }, deviceKey.headers);
      expect(mismatch.statusCode).toBe(403);
      expect(mismatch.json()).toMatchObject({ code: 'DEVICE_VESSEL_MISMATCH', deviceMmsi: vesselA1 });

      await service.app.inject({ method: 'PATCH', url: `/api/v2/telemetry/devices/${device.id}`, headers: admin, payload: { status: 'inactive' } });
      const inactive = await post({ mmsi: vesselA1, time: minutesAgo(13), fuelMeTon: 1, fuelAeTon: 0 }, deviceKey.headers);
      expect(inactive.statusCode).toBe(403);
      expect(inactive.json()).toMatchObject({ code: 'DEVICE_INACTIVE' });
    });
  });

  describe('queries (telemetry:read)', () => {
    // A UTC day three days ago: readings at 10:15, 10:45, 11:30 and 00:30 the next day.
    const day = Math.floor((now - 3 * DAY_MS) / DAY_MS) * DAY_MS;
    const at = (hours: number) => new Date(day + hours * HOUR_MS).toISOString();
    const readings = [
      { mmsi: queryVessel, time: at(10.25), fuelMeTon: 1, fuelAeTon: 0.1 },
      { mmsi: queryVessel, time: at(10.75), fuelMeTon: 2, fuelAeTon: 0.2 },
      { mmsi: queryVessel, time: at(11.5), fuelMeTon: 4, fuelAeTon: 0.4 },
      { mmsi: queryVessel, time: at(24.5), periodStart: at(24), fuelMeTon: 8, fuelAeTon: 0.8 },
    ];
    let reader: { authorization: string };
    const get = (path: string, headers: Record<string, string> = reader) =>
      service.app.inject({ method: 'GET', url: `/api/v2/telemetry/vessels/${path}`, headers });

    beforeAll(async () => {
      reader = await service.authorization({ roles: ['fleet_manager'], orgId: orgA });
      expect((await post(readings, keyA.headers)).statusCode).toBe(202);
    });

    it('pages raw readings in time order with a cursor', async () => {
      const range = `from=${at(0)}&to=${at(48)}`;
      const first = await get(`${queryVessel}/readings?${range}&limit=3`);
      expect(first.statusCode).toBe(200);
      const page1 = first.json<{ data: { time: string; readings: number; source: string }[]; page: { nextCursor: string | null; limit: number } }>();
      expect(page1.data.map((point) => point.time)).toEqual(readings.slice(0, 3).map((r) => r.time));
      expect(page1.data[0]).toMatchObject({ readings: 1, source: 'api', totalFuelTon: 1.1 });
      expect(page1.page.limit).toBe(3);
      expect(page1.page.nextCursor).toEqual(expect.any(String));

      const second = await get(`${queryVessel}/readings?${range}&limit=3&cursor=${page1.page.nextCursor ?? ''}`);
      const page2 = second.json<{ data: { time: string; periodStart: string }[]; page: { nextCursor: string | null } }>();
      expect(page2.data).toHaveLength(1);
      expect(page2.data[0]).toMatchObject({ periodStart: at(24) });
      expect(page2.page.nextCursor).toBeNull();

      const foreignCursor = await get(`${queryVessel}/readings?${range}&bucket=1h&cursor=${page1.page.nextCursor ?? ''}`);
      expect(foreignCursor.statusCode).toBe(400);
    });

    it('serves hourly and daily sums from the continuous aggregates, before and after a refresh', async () => {
      const range = `from=${at(0)}&to=${at(48)}`;
      const expectedHourly = [
        { time: at(10), fuelMeTon: 3, readings: 2 },
        { time: at(11), fuelMeTon: 4, readings: 1 },
        { time: at(24), fuelMeTon: 8, readings: 1 },
      ];
      const expectedDaily = [
        { time: at(0), fuelMeTon: 7, readings: 3 },
        { time: at(24), fuelMeTon: 8, readings: 1 },
      ];
      const series = async (bucket: string) =>
        (await get(`${queryVessel}/readings?${range}&bucket=${bucket}`))
          .json<{ data: { time: string; fuelMeTon: number; fuelAeTon: number; readings: number; source: unknown }[] }>()
          .data.map(({ time, fuelMeTon, readings: count }) => ({ time, fuelMeTon, readings: count }));

      // Real-time aggregation (nothing materialized for these buckets yet) …
      expect(await series('1h')).toEqual(expectedHourly);
      expect(await series('1d')).toEqual(expectedDaily);
      // … and the materialized aggregates give the same answer.
      await service.pool.query(`CALL refresh_continuous_aggregate('fuel_hourly', NULL, NULL)`);
      await service.pool.query(`CALL refresh_continuous_aggregate('fuel_daily', NULL, NULL)`);
      expect(await series('1h')).toEqual(expectedHourly);
      expect(await series('1d')).toEqual(expectedDaily);
    });

    it('sums readings over any range exactly (raw edges, hours, days)', async () => {
      const summary = async (from: string, to: string) =>
        (await get(`${queryVessel}/summary?from=${from}&to=${to}`)).json<Record<string, unknown>>();

      expect(await summary(at(10.5), at(24.75))).toMatchObject({
        mmsi: queryVessel,
        readings: 3,
        fuelMeTon: 14,
        totalFuelTon: expect.closeTo(15.4, 9) as unknown,
        firstReadingAt: at(10.75),
        lastReadingAt: at(24.5),
      });
      expect(await summary(at(0), at(48))).toMatchObject({ readings: 4, fuelMeTon: 15 });
      expect(await summary(at(10.3), at(10.4))).toMatchObject({ readings: 0, fuelMeTon: 0, firstReadingAt: null });
    });

    it('reports the telemetry status (active within 10 minutes) with the newest reading', async () => {
      const recent = await get(`${vesselA2}/status`);
      expect(recent.json()).toMatchObject({ mmsi: vesselA2, active: true, activeWindowMin: 10, lastReading: { source: 'api' } });

      const old = await get(`${queryVessel}/status`);
      expect(old.json()).toMatchObject({ active: false, lastReadingAt: at(24.5) });
    });

    it('lists the vessels of the organization with their telemetry', async () => {
      const response = await service.app.inject({ method: 'GET', url: '/api/v2/telemetry/vessels?pageSize=100', headers: reader });
      const body = response.json<{ data: { mmsi: number; active: boolean; devices: number; name: string }[]; meta: { total: number } }>();
      expect(response.statusCode).toBe(200);
      expect(body.data.map((vessel) => vessel.mmsi).sort()).toEqual([vesselA1, vesselA2, queryVessel].sort());
      expect(body.data.find((vessel) => vessel.mmsi === vesselA1)).toMatchObject({ name: 'KM Alpha', devices: 1, active: true });
      expect(body.data.find((vessel) => vessel.mmsi === queryVessel)).toMatchObject({ active: false, devices: 0 });
    });

    it('applies tenancy and permissions to queries', async () => {
      const readerB = await service.authorization({ roles: ['fleet_manager'], orgId: orgB });
      expect((await get(`${queryVessel}/summary`, readerB)).statusCode).toBe(403);
      expect((await get(`${unknownVessel}/status`)).json()).toMatchObject({ code: 'VESSEL_NOT_FOUND' });
      const viewer = await service.authorization({ roles: ['viewer'], orgId: orgA });
      expect((await get(`${queryVessel}/readings`, viewer)).statusCode).toBe(403);
      expect((await get('12345/status')).statusCode).toBe(400);
      const admin = await service.authorization({ roles: ['super_admin'] });
      expect((await get(`${queryVessel}/summary?from=${at(0)}&to=${at(48)}`, admin)).json()).toMatchObject({ readings: 4 });
    });
  });
});
