import { randomUUID } from 'node:crypto';

import { telemetryMqttTopic } from '@darmawanweb/ais-its-contracts/events';
import {
  testInfra,
  uniqueName,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';
import { connectAsync, type MqttClient } from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFuelEvents } from './support/fuel-events.js';
import { metricValue } from './support/metrics.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

/**
 * The shared test NATS runs the MQTT gateway on 1883 like the platform's
 * compose file (`nats` service): `testInfraGlobalSetup({ nats: { mqtt: true } })`
 * in `test/support/global-setup.ts`, its URL in `testInfra('nats').nats.mqttUrl`.
 */
describe('fuel meters over MQTT (NATS MQTT gateway)', () => {
  let service: TestService | undefined;
  let meter: MqttClient | undefined;
  const orgId = newOrgId();
  const [vessel] = uniqueMmsis(1) as [number];
  let deviceId: string;
  let admin: { authorization: string };

  const started = (): TestService => {
    if (service === undefined) throw new Error('service not started');
    return service;
  };

  beforeAll(async () => {
    const { mqttUrl } = testInfra('nats').nats;
    if (mqttUrl === undefined)
      throw new Error('the global setup started NATS without MQTT');
    // The broker devices reach, as GET /telemetry/devices/:id/connection describes it.
    service = await startTestService({ env: { TELEMETRY_MQTT_URL: mqttUrl } });
    await service.publishVessel({ mmsi: vessel, orgId });
    admin = await service.authorization({ roles: ['org_admin'], orgId });
    const created = await service.app.inject({
      method: 'POST',
      url: '/api/v2/telemetry/devices',
      headers: admin,
      payload: { mmsi: vessel, name: 'ME flow meter', kind: 'mqtt' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const device = created.json<{ id: string; mqttTopic: string }>();
    deviceId = device.id;
    expect(device.mqttTopic).toBe(`aisits/telemetry/${deviceId}`);

    meter = await connectAsync(mqttUrl, {
      clientId: uniqueName('fuel-meter'),
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 0,
    });
  });

  afterAll(async () => {
    await meter?.endAsync();
    await service?.close();
  });

  it('stores what a meter publishes to aisits/telemetry/<deviceId> (QoS 1) and publishes it to FUEL', async () => {
    const time = new Date(Date.now() - 60_000).toISOString();
    await meter?.publishAsync(
      telemetryMqttTopic(deviceId),
      JSON.stringify({ time, fuelMeTon: 0.75, fuelAeTon: 0.08 }),
      { qos: 1 },
    );

    const { pool, app } = started();
    await waitFor(
      async () =>
        (
          await pool.query(
            `SELECT 1 FROM fuel_readings WHERE mmsi = $1 AND time = $2 AND source = 'mqtt' AND device_id = $3`,
            [vessel, time, deviceId],
          )
        ).rowCount === 1,
      { timeoutMs: 15_000, message: 'MQTT reading not stored' },
    );
    const [event] = await readFuelEvents(app, vessel, 1);
    expect(event?.envelope.data).toMatchObject({
      mmsi: vessel,
      time,
      fuelMeTon: 0.75,
      deviceId,
      source: 'mqtt',
    });
  });

  it('accepts what a meter publishes with exactly the details of GET /devices/:id/connection', async () => {
    const { app, pool } = started();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/telemetry/devices',
      headers: admin,
      payload: { mmsi: vessel, name: 'AE flow meter', kind: 'mqtt' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v2/telemetry/devices/${id}/connection`,
      headers: admin,
    });
    expect(response.statusCode, response.body).toBe(200);
    const connection = response.json<{
      brokerUrl: string;
      host: string;
      port: number;
      tls: boolean;
      protocolVersion: string;
      topic: string;
      qos: 0 | 1;
      username: string | null;
    }>();
    expect(connection).toMatchObject({
      brokerUrl: testInfra('nats').nats.mqttUrl,
      tls: false,
      protocolVersion: '3.1.1',
      topic: telemetryMqttTopic(id),
      qos: 1,
      username: null,
    });

    const client = await connectAsync({
      host: connection.host,
      port: connection.port,
      protocol: connection.tls ? 'mqtts' : 'mqtt',
      // MQTT 3.1.1 is protocol level 4.
      protocolVersion: connection.protocolVersion === '3.1.1' ? 4 : 5,
      clientId: uniqueName('ae-meter'),
      connectTimeout: 10_000,
      reconnectPeriod: 0,
    });
    const time = new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000);
    try {
      await client.publishAsync(
        connection.topic,
        JSON.stringify({
          time: time.toISOString(),
          fuelMeTon: 0,
          fuelAeTon: 0.02,
        }),
        { qos: connection.qos },
      );
    } finally {
      await client.endAsync();
    }

    await waitFor(
      async () =>
        (
          await pool.query(
            'SELECT 1 FROM fuel_readings WHERE mmsi = $1 AND time = $2 AND device_id = $3',
            [vessel, time, id],
          )
        ).rowCount === 1,
      {
        timeoutMs: 15_000,
        message: 'reading of the connection guide not stored',
      },
    );
    const device = await app.inject({
      method: 'GET',
      url: `/api/v2/telemetry/devices/${id}`,
      headers: admin,
    });
    expect(device.json()).toMatchObject({
      lastReadingAt: time.toISOString(),
      connectionState: 'online',
    });
  });

  it('counts and drops messages on topics of unknown devices', async () => {
    const { app } = started();
    const before = await metricValue(
      app,
      'aisits_telemetry_device_messages_total',
      {
        outcome: 'unknown_device',
      },
    );
    await meter?.publishAsync(
      telemetryMqttTopic(randomUUID()),
      JSON.stringify({
        time: new Date().toISOString(),
        fuelMeTon: 1,
        fuelAeTon: 0,
      }),
      { qos: 0 },
    );
    await waitFor(
      async () =>
        (await metricValue(app, 'aisits_telemetry_device_messages_total', {
          outcome: 'unknown_device',
        })) ===
        before + 1,
      { timeoutMs: 15_000, message: 'unknown device not counted' },
    );
  });
});
