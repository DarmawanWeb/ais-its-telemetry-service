import { randomUUID } from 'node:crypto';

import { parseEnvelope, subjects } from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DevicesRepository } from '../src/modules/devices/devices.repository.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

const DEVICES_URL = '/api/v2/telemetry/devices';

interface DeviceBody {
  readonly id: string;
  readonly orgId: string;
  readonly mmsi: number;
  readonly vesselName: string | null;
  readonly name: string;
  readonly kind: 'mqtt' | 'http';
  readonly apiKeyId: string | null;
  readonly status: 'active' | 'inactive';
  readonly serialNumber: string | null;
  readonly mqttTopic: string | null;
  readonly lastSeenAt: string | null;
  readonly lastReadingAt: string | null;
  readonly connectionState:
    'online' | 'idle' | 'offline' | 'never' | 'inactive';
  readonly activeWindowMin: number;
  readonly offlineAfterMin: number;
  readonly createdBy: string | null;
}

interface DevicePageBody {
  readonly data: DeviceBody[];
  readonly meta: { page: number; pageSize: number; total: number };
}

describe('device registry /telemetry/devices (device:manage)', () => {
  let service: TestService;
  const orgA = newOrgId();
  const orgB = newOrgId();
  const adminAId = randomUUID();
  const [vesselA1, vesselA2, vesselB1, unknownVessel, orphanVessel] =
    uniqueMmsis(5) as [number, number, number, number, number];
  let adminA: { authorization: string };
  let adminB: { authorization: string };
  let superAdmin: { authorization: string };

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    headers: Record<string, string>,
    payload?: object,
  ) =>
    service.app.inject({
      method,
      url: `${DEVICES_URL}${path}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });

  const create = async (
    payload: object,
    headers: Record<string, string> = adminA,
  ): Promise<DeviceBody> => {
    const response = await request('POST', '', headers, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<DeviceBody>();
  };

  beforeAll(async () => {
    service = await startTestService();
    adminA = await service.authorization({
      roles: ['org_admin'],
      orgId: orgA,
      userId: adminAId,
    });
    adminB = await service.authorization({ roles: ['org_admin'], orgId: orgB });
    superAdmin = await service.authorization({ roles: ['super_admin'] });
    await service.publishVessel({ mmsi: vesselA1, orgId: orgA });
    await service.publishVessel({ mmsi: vesselA2, orgId: orgA });
    await service.publishVessel({ mmsi: vesselB1, orgId: orgB });
    await service.publishVessel({ mmsi: orphanVessel, orgId: null });
  });

  afterAll(async () => {
    await service.close();
  });

  it('registers mqtt and http devices on vessels of the active organization', async () => {
    const meter = await create({
      mmsi: vesselA1,
      name: 'ME flow meter',
      kind: 'mqtt',
      serialNumber: '  FM-2041-0007  ',
    });
    expect(meter).toMatchObject({
      orgId: orgA,
      mmsi: vesselA1,
      name: 'ME flow meter',
      kind: 'mqtt',
      apiKeyId: null,
      status: 'active',
      serialNumber: 'FM-2041-0007',
      mqttTopic: `aisits/telemetry/${meter.id}`,
      lastSeenAt: null,
      lastReadingAt: null,
      connectionState: 'never',
      activeWindowMin: 10,
      offlineAfterMin: 1440,
      createdBy: adminAId,
    });
    expect(meter.vesselName).toEqual(expect.any(String));

    const key = service.apiKey(orgA);
    const gateway = await create({
      mmsi: vesselA1,
      name: 'Bridge gateway',
      kind: 'http',
      apiKeyId: key.keyId,
      status: 'inactive',
    });
    expect(gateway).toMatchObject({
      kind: 'http',
      apiKeyId: key.keyId,
      status: 'inactive',
      mqttTopic: null,
      connectionState: 'inactive',
    });
  });

  it('validates the input and the credential rule of the kind', async () => {
    const invalid = async (payload: object) => {
      const response = await request('POST', '', adminA, payload);
      expect(response.statusCode).toBe(400);
      const problem = response.json<{
        code: string;
        errors: { field: string }[];
      }>();
      expect(problem.code).toBe('VALIDATION_FAILED');
      return problem.errors.map((error) => error.field);
    };

    expect(
      await invalid({ mmsi: vesselA1, name: 'No key', kind: 'http' }),
    ).toEqual(['apiKeyId']);
    expect(
      await invalid({
        mmsi: vesselA1,
        name: 'Keyed meter',
        kind: 'mqtt',
        apiKeyId: randomUUID(),
      }),
    ).toEqual(['apiKeyId']);
    expect(
      await invalid({ mmsi: 12345, name: 'x', kind: 'serial', extra: 1 }),
    ).toEqual(expect.arrayContaining(['mmsi', 'kind', 'extra']));
    expect(
      await invalid({ mmsi: vesselA1, name: '   ', kind: 'mqtt' }),
    ).toEqual(['name']);
  });

  it('keeps names and API keys unique within an organization', async () => {
    const duplicateName = await request('POST', '', adminA, {
      mmsi: vesselA2,
      name: 'ME flow meter',
      kind: 'mqtt',
    });
    expect(duplicateName.statusCode).toBe(409);
    expect(duplicateName.json()).toMatchObject({ code: 'DEVICE_NAME_TAKEN' });

    const key = service.apiKey(orgA);
    await create({
      mmsi: vesselA2,
      name: 'Gateway 2',
      kind: 'http',
      apiKeyId: key.keyId,
    });
    const duplicateKey = await request('POST', '', adminA, {
      mmsi: vesselA2,
      name: 'Gateway 3',
      kind: 'http',
      apiKeyId: key.keyId,
    });
    expect(duplicateKey.statusCode).toBe(409);
    expect(duplicateKey.json()).toMatchObject({
      code: 'DEVICE_API_KEY_TAKEN',
      apiKeyId: key.keyId,
    });

    // Another organization may use the same name.
    await create(
      { mmsi: vesselB1, name: 'ME flow meter', kind: 'mqtt' },
      adminB,
    );
  });

  it('derives the organization from the vessel, never from the client', async () => {
    const foreign = await request('POST', '', adminA, {
      mmsi: vesselB1,
      name: 'Foreign meter',
      kind: 'mqtt',
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({
      code: 'FORBIDDEN',
      mmsi: [vesselB1],
    });

    const unknown = await request('POST', '', adminA, {
      mmsi: unknownVessel,
      name: 'Lost meter',
      kind: 'mqtt',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({
      code: 'VESSEL_NOT_FOUND',
      mmsi: unknownVessel,
    });

    const orphan = await request('POST', '', superAdmin, {
      mmsi: orphanVessel,
      name: 'Orphan meter',
      kind: 'mqtt',
    });
    expect(orphan.statusCode).toBe(422);
    expect(orphan.json()).toMatchObject({
      code: 'VESSEL_WITHOUT_ORGANIZATION',
    });

    // A platform administrator registers devices for any organization's vessel.
    const forB = await create(
      { mmsi: vesselB1, name: 'Installed by support', kind: 'mqtt' },
      superAdmin,
    );
    expect(forB.orgId).toBe(orgB);
  });

  it('lists, filters and pages the devices of the organization', async () => {
    const list = async (
      query: string,
      headers: Record<string, string> = adminA,
    ) => {
      const response = await request('GET', query, headers);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<DevicePageBody>();
    };

    const all = await list('');
    expect(all.meta).toEqual({ page: 1, pageSize: 20, total: 3 });
    expect(all.data.every((device) => device.orgId === orgA)).toBe(true);
    // Ordered by vessel, then name.
    expect(all.data.map((device) => device.name)).toEqual([
      'Bridge gateway',
      'ME flow meter',
      'Gateway 2',
    ]);

    expect((await list('?kind=mqtt')).data.map((d) => d.name)).toEqual([
      'ME flow meter',
    ]);
    expect((await list('?status=inactive')).data.map((d) => d.name)).toEqual([
      'Bridge gateway',
    ]);
    expect((await list(`?mmsi=${vesselA2}`)).data.map((d) => d.name)).toEqual([
      'Gateway 2',
    ]);
    expect((await list('?search=fm-2041')).data.map((d) => d.name)).toEqual([
      'ME flow meter',
    ]);
    expect((await list('?search=%25')).meta.total).toBe(0);

    const page2 = await list('?pageSize=2&page=2');
    expect(page2.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(page2.data.map((d) => d.name)).toEqual(['Gateway 2']);

    const everyone = await list('?pageSize=100', superAdmin);
    // Other test files share the database: platform administrators see their devices too.
    expect(everyone.data.map((d) => d.orgId)).toEqual(
      expect.arrayContaining([orgA, orgB]),
    );
    expect((await list(`?orgId=${orgB}`, superAdmin)).meta.total).toBe(2);

    const foreignFilter = await request('GET', `?orgId=${orgB}`, adminA);
    expect(foreignFilter.statusCode).toBe(403);
  });

  it('gets, updates and deletes a device', async () => {
    const device = await create({
      mmsi: vesselA1,
      name: 'AE meter',
      kind: 'mqtt',
    });

    const fetched = await request('GET', `/${device.id}`, adminA);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(device);

    const renamed = await request('PATCH', `/${device.id}`, adminA, {
      name: 'AE meter (port)',
      serialNumber: 'AE-1',
      mmsi: vesselA2,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({
      name: 'AE meter (port)',
      serialNumber: 'AE-1',
      mmsi: vesselA2,
      orgId: orgA,
    });

    const moved = await request('PATCH', `/${device.id}`, adminA, {
      mmsi: vesselB1,
    });
    expect(moved.statusCode).toBe(403);

    const keyless = await request('PATCH', `/${device.id}`, adminA, {
      kind: 'http',
    });
    expect(keyless.statusCode).toBe(400);
    const key = service.apiKey(orgA);
    const rekeyed = await request('PATCH', `/${device.id}`, adminA, {
      kind: 'http',
      apiKeyId: key.keyId,
      serialNumber: null,
    });
    expect(rekeyed.json()).toMatchObject({
      kind: 'http',
      apiKeyId: key.keyId,
      serialNumber: null,
      mqttTopic: null,
    });

    const unchanged = await request('PATCH', `/${device.id}`, adminA, {});
    expect(unchanged.json<DeviceBody>().name).toBe('AE meter (port)');

    // null only clears the nullable fields; the others answer 400, not 500/404.
    for (const field of ['name', 'status', 'kind', 'mmsi']) {
      const cleared = await request('PATCH', `/${device.id}`, adminA, {
        [field]: null,
      });
      expect(cleared.statusCode, `${field}: ${cleared.body}`).toBe(400);
      expect(cleared.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: expect.arrayContaining([
          expect.objectContaining({ field }),
        ]) as unknown,
      });
    }

    expect((await request('DELETE', `/${device.id}`, adminA)).statusCode).toBe(
      204,
    );
    const gone = await request('GET', `/${device.id}`, adminA);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({
      code: 'DEVICE_NOT_FOUND',
      id: device.id,
    });
    expect((await request('DELETE', `/${device.id}`, adminA)).statusCode).toBe(
      404,
    );
    const malformed = await request('GET', '/not-a-uuid', adminA);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'id', code: 'isUuid' })],
    });
  });

  it('hides devices of other organizations and requires device:manage', async () => {
    const device = await create({
      mmsi: vesselA1,
      name: 'Hidden meter',
      kind: 'mqtt',
    });

    expect((await request('GET', `/${device.id}`, adminB)).statusCode).toBe(
      404,
    );
    expect(
      (await request('PATCH', `/${device.id}`, adminB, { status: 'inactive' }))
        .statusCode,
    ).toBe(404);
    expect((await request('DELETE', `/${device.id}`, adminB)).statusCode).toBe(
      404,
    );

    const manager = await service.authorization({
      roles: ['fleet_manager'],
      orgId: orgA,
    });
    expect((await request('GET', '', manager)).statusCode).toBe(403);
    const viewer = await service.authorization({
      roles: ['viewer'],
      orgId: orgA,
    });
    expect(
      (
        await request('POST', '', viewer, {
          mmsi: vesselA1,
          name: 'x',
          kind: 'mqtt',
        })
      ).statusCode,
    ).toBe(403);
    expect((await request('GET', '', {})).statusCode).toBe(401);
    // API keys are refused on the registry.
    expect(
      (await request('GET', '', service.apiKey(orgA).headers)).statusCode,
    ).toBe(401);
  });

  it('shows the vessel name, the newest reading and the connection state of every device', async () => {
    const [vessel, other] = uniqueMmsis(2) as [number, number];
    const snapshot = await service.publishVessel({
      mmsi: vessel,
      orgId: orgA,
      name: 'KM Sinar Bahari',
    });
    await service.publishVessel({ mmsi: other, orgId: orgA, name: 'KM Lain' });
    const now = Math.floor(Date.now() / 1000) * 1000;
    const minutesAgo = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString();

    // http devices report through their keys: newest readings 1 min, 1 h and 2 days old.
    const reporting = async (name: string, ages: readonly number[]) => {
      const key = service.apiKey(orgA);
      const device = await create({
        mmsi: vessel,
        name,
        kind: 'http',
        apiKeyId: key.keyId,
      });
      const posted = await service.app.inject({
        method: 'POST',
        url: '/api/v2/telemetry/readings',
        headers: key.headers,
        payload: ages.map((age) => ({
          mmsi: vessel,
          time: minutesAgo(age),
          fuelMeTon: 0.1,
          fuelAeTon: 0.01,
        })),
      });
      expect(posted.statusCode, posted.body).toBe(202);
      return device;
    };
    const online = await reporting('Online gateway', [31, 1]);
    const idle = await reporting('Idle gateway', [60]);
    const offline = await reporting('Offline gateway', [2 * 1440]);
    const silent = await create({
      mmsi: vessel,
      name: 'New meter',
      kind: 'mqtt',
    });
    const off = await create({
      mmsi: vessel,
      name: 'Spare meter',
      kind: 'mqtt',
      status: 'inactive',
    });
    expect(silent).toMatchObject({
      vesselName: 'KM Sinar Bahari',
      connectionState: 'never',
    });

    const response = await request('GET', `?mmsi=${vessel}`, adminA);
    expect(response.statusCode, response.body).toBe(200);
    const byName = new Map(
      response
        .json<DevicePageBody>()
        .data.map((device) => [device.name, device] as const),
    );
    expect(byName.get(online.name)).toMatchObject({
      vesselName: 'KM Sinar Bahari',
      // The newest of the batch, whatever its order in the request.
      lastReadingAt: minutesAgo(1),
      connectionState: 'online',
      activeWindowMin: 10,
      offlineAfterMin: 1440,
    });
    expect(byName.get(online.name)?.lastSeenAt).not.toBeNull();
    expect(byName.get(idle.name)).toMatchObject({
      lastReadingAt: minutesAgo(60),
      connectionState: 'idle',
    });
    expect(byName.get(offline.name)).toMatchObject({
      lastReadingAt: minutesAgo(2 * 1440),
      connectionState: 'offline',
    });
    expect(byName.get(silent.name)).toMatchObject({
      lastSeenAt: null,
      lastReadingAt: null,
      connectionState: 'never',
    });
    expect(byName.get(off.name)?.connectionState).toBe('inactive');

    // Moving a device names its new vessel; a deleted vessel has no name.
    const moved = await request('PATCH', `/${silent.id}`, adminA, {
      mmsi: other,
    });
    expect(moved.json()).toMatchObject({ mmsi: other, vesselName: 'KM Lain' });
    await service.deleteVessel(snapshot);
    const orphaned = await request('GET', `/${online.id}`, adminA);
    expect(orphaned.json()).toMatchObject({
      mmsi: vessel,
      vesselName: null,
      connectionState: 'online',
    });
  });

  it('counts the readings of the current vessel only: a move makes a reporting device never until it reports there', async () => {
    const [from, to] = uniqueMmsis(2) as [number, number];
    await service.publishVessel({ mmsi: from, orgId: orgA, name: 'KM Asal' });
    await service.publishVessel({ mmsi: to, orgId: orgA, name: 'KM Tujuan' });
    const now = Math.floor(Date.now() / 1000) * 1000;
    const minutesAgo = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString();
    const key = service.apiKey(orgA);
    const device = await create({
      mmsi: from,
      name: 'Moving gateway',
      kind: 'http',
      apiKeyId: key.keyId,
    });
    const report = async (mmsi: number, age: number) => {
      const posted = await service.app.inject({
        method: 'POST',
        url: '/api/v2/telemetry/readings',
        headers: key.headers,
        payload: [
          { mmsi, time: minutesAgo(age), fuelMeTon: 0.1, fuelAeTon: 0.01 },
        ],
      });
      expect(posted.statusCode, posted.body).toBe(202);
    };
    const vesselStatus = async (mmsi: number) => {
      const response = await service.app.inject({
        method: 'GET',
        url: `/api/v2/telemetry/vessels/${mmsi}/status`,
        headers: adminA,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ active: boolean; lastReadingAt: string | null }>();
    };
    const get = async () =>
      (await request('GET', `/${device.id}`, adminA)).json<DeviceBody>();

    await report(from, 1);
    const reporting = await get();
    expect(reporting).toMatchObject({
      lastReadingAt: minutesAgo(1),
      connectionState: 'online',
    });
    expect(reporting.lastSeenAt).not.toBeNull();

    // A change that keeps the vessel keeps the newest reading.
    const renamed = await request('PATCH', `/${device.id}`, adminA, {
      mmsi: from,
      name: 'Moved gateway',
    });
    expect(renamed.json()).toMatchObject({
      lastReadingAt: minutesAgo(1),
      connectionState: 'online',
    });

    // The move clears it in the same statement: the readings stay on the
    // previous vessel, the new one has no telemetry, and an online device
    // always means active telemetry of its vessel.
    const moved = await request('PATCH', `/${device.id}`, adminA, { mmsi: to });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      mmsi: to,
      vesselName: 'KM Tujuan',
      lastSeenAt: reporting.lastSeenAt,
      lastReadingAt: null,
      connectionState: 'never',
    });
    expect(await vesselStatus(to)).toMatchObject({
      active: false,
      lastReadingAt: null,
    });
    expect(await vesselStatus(from)).toMatchObject({ active: true });

    // A batch received before the move but marked after it (its readings are
    // on the previous vessel) refreshes the receipt only.
    const seenAt = new Date(now + 5 * 60_000);
    await service.app
      .get(DevicesRepository)
      .markSeen({ id: device.id, mmsi: from }, seenAt, new Date(now));
    expect(await get()).toMatchObject({
      lastSeenAt: seenAt.toISOString(),
      lastReadingAt: null,
      connectionState: 'never',
    });

    // Its first reading on the new vessel counts.
    await report(to, 2);
    expect(await get()).toMatchObject({
      mmsi: to,
      lastReadingAt: minutesAgo(2),
      connectionState: 'online',
    });
    expect(await vesselStatus(to)).toMatchObject({
      active: true,
      lastReadingAt: minutesAgo(2),
    });
  });

  it('describes the MQTT connection of an mqtt device, never a secret', async () => {
    const meter = await create({
      mmsi: vesselA1,
      name: 'Connection meter',
      kind: 'mqtt',
    });
    const connection = await request('GET', `/${meter.id}/connection`, adminA);
    expect(connection.statusCode, connection.body).toBe(200);
    // The development broker of the test configuration (TELEMETRY_MQTT_URL default).
    expect(connection.json()).toEqual({
      deviceId: meter.id,
      brokerUrl: 'mqtt://localhost:1883',
      host: 'localhost',
      port: 1883,
      tls: false,
      protocolVersion: '3.1.1',
      topic: `aisits/telemetry/${meter.id}`,
      qos: 1,
      authentication: 'none',
      username: null,
    });
    expect(
      (await request('GET', `/${meter.id}/connection`, superAdmin)).statusCode,
    ).toBe(200);

    const gateway = await create({
      mmsi: vesselA1,
      name: 'Connection gateway',
      kind: 'http',
      apiKeyId: service.apiKey(orgA).keyId,
    });
    const http = await request('GET', `/${gateway.id}/connection`, adminA);
    expect(http.statusCode).toBe(409);
    expect(http.json()).toMatchObject({
      code: 'DEVICE_NOT_MQTT',
      deviceId: gateway.id,
    });

    const foreign = await request('GET', `/${meter.id}/connection`, adminB);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    expect(
      (await request('GET', `/${randomUUID()}/connection`, adminA)).statusCode,
    ).toBe(404);
    const malformed = await request('GET', '/meter-7/connection', adminA);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'id', code: 'isUuid' })],
    });
    const manager = await service.authorization({
      roles: ['fleet_manager'],
      orgId: orgA,
    });
    expect(
      (await request('GET', `/${meter.id}/connection`, manager)).statusCode,
    ).toBe(403);
  });

  it('lists the devices of a vessel read-only for telemetry:read, without credentials', async () => {
    const [vessel, bare] = uniqueMmsis(2) as [number, number];
    await service.publishVessel({ mmsi: vessel, orgId: orgA });
    await service.publishVessel({ mmsi: bare, orgId: orgA });
    const meterB = await create({
      mmsi: vessel,
      name: 'Vessel meter B',
      kind: 'http',
      apiKeyId: randomUUID(),
      serialNumber: 'SN-B',
    });
    const meterA = await create({
      mmsi: vessel,
      name: 'Vessel meter A',
      kind: 'mqtt',
    });
    await create({ mmsi: vesselA1, name: 'Meter elsewhere', kind: 'mqtt' });
    expect(
      (await request('PATCH', `/${meterB.id}`, adminA, { status: 'inactive' }))
        .statusCode,
    ).toBe(200);

    const list = (
      mmsi: number | string,
      headers: Record<string, string>,
      query = '',
    ) =>
      service.app.inject({
        method: 'GET',
        url: `/api/v2/telemetry/vessels/${mmsi}/devices${query}`,
        headers,
      });
    const manager = await service.authorization({
      roles: ['fleet_manager'],
      orgId: orgA,
    });
    const response = await list(vessel, manager);
    expect(response.statusCode).toBe(200);
    // By name; id, name, kind, status and lastSeenAt only (no API key,
    // serial number, MQTT topic or creator).
    expect(response.json()).toEqual({
      data: [
        {
          id: meterA.id,
          name: 'Vessel meter A',
          kind: 'mqtt',
          status: 'active',
          lastSeenAt: null,
        },
        {
          id: meterB.id,
          name: 'Vessel meter B',
          kind: 'http',
          status: 'inactive',
          lastSeenAt: null,
        },
      ],
      meta: { page: 1, pageSize: 20, total: 2 },
    });
    expect(
      (await list(vessel, manager, '?page=2&pageSize=1')).json(),
    ).toMatchObject({
      data: [{ id: meterB.id }],
      meta: { page: 2, pageSize: 1, total: 2 },
    });
    expect((await list(bare, manager)).json()).toEqual({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
    expect(
      (await list(vessel, superAdmin)).json<DevicePageBody>().meta.total,
    ).toBe(2);

    // Tenancy and permissions: the vessel's organization only, telemetry:read.
    const managerB = await service.authorization({
      roles: ['fleet_manager'],
      orgId: orgB,
    });
    expect((await list(vessel, managerB)).json()).toMatchObject({
      code: 'FORBIDDEN',
    });
    const viewer = await service.authorization({
      roles: ['viewer'],
      orgId: orgA,
    });
    expect((await list(vessel, viewer)).statusCode).toBe(403);
    expect((await list(unknownVessel, manager)).json()).toMatchObject({
      code: 'VESSEL_NOT_FOUND',
    });
    expect((await list('12345', manager)).json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'mmsi', code: 'isMmsi' })],
    });
    expect((await list(vessel, service.apiKey(orgA).headers)).statusCode).toBe(
      401,
    );
  });

  it('records an audit event for every change', async () => {
    const device = await create({
      mmsi: vesselA2,
      name: 'Audited meter',
      kind: 'mqtt',
    });
    expect((await request('DELETE', `/${device.id}`, adminA)).statusCode).toBe(
      204,
    );

    const { manager } = await service.app.get(NatsClient).ready();
    const stored = await manager.streams.getMessage('AUDIT', {
      last_by_subj: subjects.audit('telemetry'),
    });
    const parsed = parseEnvelope(stored?.data ?? new Uint8Array());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.envelope.data).toMatchObject({
      action: 'device.delete',
      actorType: 'user',
      actorId: adminAId,
      orgId: orgA,
      targetType: 'device',
      targetId: device.id,
      meta: { mmsi: vesselA2 },
    });
  });
});
