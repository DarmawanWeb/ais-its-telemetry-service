import { randomUUID } from 'node:crypto';

import { parseEnvelope, subjects } from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  readonly name: string;
  readonly kind: 'mqtt' | 'http';
  readonly apiKeyId: string | null;
  readonly status: 'active' | 'inactive';
  readonly serialNumber: string | null;
  readonly mqttTopic: string | null;
  readonly lastSeenAt: string | null;
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
      createdBy: adminAId,
    });

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
    expect((await request('GET', '/not-a-uuid', adminA)).statusCode).toBe(400);
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
