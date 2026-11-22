import { randomUUID } from 'node:crypto';

import {
  type VesselSnapshotV1,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFuelEvents } from './support/fuel-events.js';
import { metricValue } from './support/metrics.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

const DEVICE_MESSAGES = 'aisits_telemetry_device_messages_total';

/**
 * The MQTT path as the NATS MQTT gateway delivers it: raw device JSON on the
 * core subject `aisits.telemetry.<deviceId>` (MQTT topic
 * `aisits/telemetry/<deviceId>`), published here with a plain NATS client.
 */
describe('device messages on aisits.telemetry.<deviceId>', () => {
  let service: TestService;
  let admin: { authorization: string };
  const orgA = newOrgId();
  const orgB = newOrgId();
  const [vessel, movedVessel, deletedVessel] = uniqueMmsis(3) as [
    number,
    number,
    number,
  ];
  const devices: Record<
    'meter' | 'off' | 'http' | 'moved' | 'deleted',
    string
  > = {
    meter: '',
    off: '',
    http: '',
    moved: '',
    deleted: '',
  };
  let movedSnapshot: VesselSnapshotV1;
  let deletedSnapshot: VesselSnapshotV1;
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();

  const registerDevice = async (payload: object): Promise<string> => {
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/v2/telemetry/devices',
      headers: admin,
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  };

  /** Publishes a device message on the core subject (`subject` overrides the device's). */
  const send = async (deviceId: string, payload: unknown, subject?: string) => {
    const { connection } = await service.app.get(NatsClient).ready();
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    connection.publish(
      subject ?? subjects.telemetryMqtt(deviceId),
      new TextEncoder().encode(body),
    );
    await connection.flush();
  };

  const outcome = (name: string) =>
    metricValue(service.app, DEVICE_MESSAGES, { outcome: name });

  /** Sends a message and waits until its outcome was counted. */
  const sendAndCount = async (
    name: string,
    deviceId: string,
    payload: unknown,
    subject?: string,
  ) => {
    const before = await outcome(name);
    await send(deviceId, payload, subject);
    await waitFor(async () => (await outcome(name)) === before + 1, {
      timeoutMs: 10_000,
      message: `outcome ${name} not counted`,
    });
  };

  const storedReadings = async (deviceId: string) =>
    (
      await service.pool.query<{
        mmsi: number;
        time: Date;
        source: string;
        fuel_me_ton: number;
        published: boolean;
      }>(
        `SELECT mmsi, time, source, fuel_me_ton, published_at IS NOT NULL AS published
         FROM fuel_readings WHERE device_id = $1 ORDER BY time`,
        [deviceId],
      )
    ).rows;

  beforeAll(async () => {
    service = await startTestService();
    admin = await service.authorization({ roles: ['org_admin'], orgId: orgA });
    await service.publishVessel({ mmsi: vessel, orgId: orgA });
    movedSnapshot = await service.publishVessel({
      mmsi: movedVessel,
      orgId: orgA,
    });
    deletedSnapshot = await service.publishVessel({
      mmsi: deletedVessel,
      orgId: orgA,
    });
    devices.meter = await registerDevice({
      mmsi: vessel,
      name: 'ME meter',
      kind: 'mqtt',
    });
    devices.off = await registerDevice({
      mmsi: vessel,
      name: 'Spare meter',
      kind: 'mqtt',
      status: 'inactive',
    });
    devices.http = await registerDevice({
      mmsi: vessel,
      name: 'HTTP gateway',
      kind: 'http',
      apiKeyId: service.apiKey(orgA).keyId,
    });
    devices.moved = await registerDevice({
      mmsi: movedVessel,
      name: 'Meter of a sold vessel',
      kind: 'mqtt',
    });
    devices.deleted = await registerDevice({
      mmsi: deletedVessel,
      name: 'Meter of a scrapped vessel',
      kind: 'mqtt',
    });
  });

  afterAll(async () => {
    await service.close();
  });

  it('stores a reading for the vessel of the device and publishes it to FUEL', async () => {
    const time = minutesAgo(2);
    const periodStart = minutesAgo(3);
    await sendAndCount('accepted', devices.meter, {
      time,
      periodStart,
      fuelMeTon: 0.42,
      fuelAeTon: 0.05,
      firmware: '2.1.0',
    });

    expect(await storedReadings(devices.meter)).toEqual([
      {
        mmsi: vessel,
        time: new Date(time),
        source: 'mqtt',
        fuel_me_ton: 0.42,
        published: true,
      },
    ]);
    const [event] = await readFuelEvents(service.app, vessel, 1);
    expect(event?.msgId).toBe(`${vessel}:${time}`);
    expect(event?.envelope.data).toEqual({
      mmsi: vessel,
      time,
      periodStart,
      fuelMeTon: 0.42,
      fuelAeTon: 0.05,
      deviceId: devices.meter,
      source: 'mqtt',
    });

    const device = await service.app.inject({
      method: 'GET',
      url: `/api/v2/telemetry/devices/${devices.meter}`,
      headers: admin,
    });
    expect(
      device.json<{ lastSeenAt: string | null }>().lastSeenAt,
    ).not.toBeNull();
  });

  it('accepts store-and-forward arrays and ignores repeated messages', async () => {
    const batch = [
      { time: minutesAgo(30), fuelMeTon: 1, fuelAeTon: 0.1 },
      { time: minutesAgo(20), fuelMeTon: 2, fuelAeTon: 0.2 },
    ];
    await sendAndCount('accepted', devices.meter, batch);
    expect(await storedReadings(devices.meter)).toHaveLength(3);

    await sendAndCount('duplicate', devices.meter, batch);
    expect(await storedReadings(devices.meter)).toHaveLength(3);
    expect(
      await metricValue(service.app, 'aisits_telemetry_readings_total', {
        source: 'mqtt',
        outcome: 'duplicate',
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('rejects and counts messages of unknown, inactive and http devices', async () => {
    const reading = { time: minutesAgo(40), fuelMeTon: 1, fuelAeTon: 0 };
    await sendAndCount('unknown_device', randomUUID(), reading);
    await sendAndCount('inactive_device', devices.off, reading);
    await sendAndCount('transport_mismatch', devices.http, reading);

    const { rows } = await service.pool.query(
      'SELECT 1 FROM fuel_readings WHERE mmsi = $1 AND time = $2',
      [vessel, reading.time],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects and counts malformed and implausible payloads', async () => {
    await sendAndCount('invalid_json', devices.meter, '{"time": ');
    await sendAndCount('invalid_payload', devices.meter, {
      time: 'yesterday',
      fuelMeTon: 1,
      fuelAeTon: 0,
    });
    await sendAndCount('invalid_payload', devices.meter, {
      time: minutesAgo(1),
      fuelMeTon: 1,
    });

    const rejectedBefore = await metricValue(
      service.app,
      'aisits_telemetry_readings_total',
      {
        source: 'mqtt',
        outcome: 'rejected',
      },
    );
    await sendAndCount('invalid_payload', devices.meter, [
      { time: minutesAgo(5), fuelMeTon: 1, fuelAeTon: 0 },
      { time: minutesAgo(4), fuelMeTon: -1, fuelAeTon: 0 },
    ]);
    // All or nothing: the plausible reading of the message is not stored either.
    expect(
      await metricValue(service.app, 'aisits_telemetry_readings_total', {
        source: 'mqtt',
        outcome: 'rejected',
      }),
    ).toBe(rejectedBefore + 2);
    await sendAndCount('invalid_payload', devices.meter, {
      time: new Date(Date.now() + 10 * 60_000).toISOString(),
      fuelMeTon: 1,
      fuelAeTon: 0,
    });
    await sendAndCount(
      'invalid_subject',
      devices.meter,
      { time: minutesAgo(6), fuelMeTon: 1, fuelAeTon: 0 },
      'aisits.telemetry.not-a-uuid',
    );
    expect(await storedReadings(devices.meter)).toHaveLength(3);
  });

  it('rejects messages once the vessel left the organization or the fleet', async () => {
    await service.publishVessel({
      ...movedSnapshot,
      orgId: orgB,
      updatedAt: new Date(
        Date.parse(movedSnapshot.updatedAt) + 1000,
      ).toISOString(),
    });
    await sendAndCount('vessel_mismatch', devices.moved, {
      time: minutesAgo(7),
      fuelMeTon: 1,
      fuelAeTon: 0,
    });

    await service.deleteVessel(deletedSnapshot);
    await sendAndCount('vessel_not_found', devices.deleted, {
      time: minutesAgo(8),
      fuelMeTon: 1,
      fuelAeTon: 0,
    });

    expect(await storedReadings(devices.moved)).toEqual([]);
    expect(await storedReadings(devices.deleted)).toEqual([]);
  });
  it('leaves out readings of a second meter at an instant the vessel has a reading for, and counts the conflict', async () => {
    const aeMeter = await registerDevice({
      mmsi: vessel,
      name: 'AE meter',
      kind: 'mqtt',
    });
    const time = minutesAgo(45);
    await sendAndCount('accepted', devices.meter, {
      time,
      fuelMeTon: 1.5,
      fuelAeTon: 0,
    });
    const conflictsBefore = await metricValue(
      service.app,
      'aisits_telemetry_readings_total',
      { source: 'mqtt', outcome: 'conflict' },
    );

    // Same instant from the other meter: not a duplicate, not stored.
    await sendAndCount('conflict', aeMeter, {
      time,
      fuelMeTon: 0,
      fuelAeTon: 0.3,
    });
    expect(await storedReadings(aeMeter)).toEqual([]);

    // Store and forward: the conflicting reading is left out, the rest is kept.
    const next = minutesAgo(44);
    await sendAndCount('conflict', aeMeter, [
      { time, fuelMeTon: 0, fuelAeTon: 0.3 },
      { time: next, fuelMeTon: 0, fuelAeTon: 0.2 },
    ]);
    expect(
      (await storedReadings(aeMeter)).map((row) => row.time.toISOString()),
    ).toEqual([next]);
    expect(
      await metricValue(service.app, 'aisits_telemetry_readings_total', {
        source: 'mqtt',
        outcome: 'conflict',
      }),
    ).toBe(conflictsBefore + 2);

    const { rows } = await service.pool.query<{ device_id: string }>(
      'SELECT device_id FROM fuel_readings WHERE mmsi = $1 AND time = $2',
      [vessel, time],
    );
    expect(rows).toEqual([{ device_id: devices.meter }]);
  });
});
