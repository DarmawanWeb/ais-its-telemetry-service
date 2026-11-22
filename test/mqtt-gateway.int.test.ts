import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { telemetryMqttTopic } from '@darmawanweb/ais-its-contracts/events';
import {
  TEST_CONTAINER_LABELS,
  TEST_IMAGES,
  uniqueName,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';
import { connectAsync, type MqttClient } from 'mqtt';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
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
 * NATS with JetStream and the MQTT gateway on 1883, as in the platform's
 * compose file (`nats` service). The kit's `startTestInfra()` has no MQTT
 * option, so this file starts its own server (labelled like the kit's test
 * containers, so `reapOrphanedTestContainers()` also removes it).
 */
const MQTT_NATS_CONFIG = `
server_name: telemetry-mqtt-test
port: 4222
jetstream { store_dir: /tmp/jetstream }
mqtt { port: 1883 }
`;

async function startMqttNats(): Promise<StartedTestContainer> {
  return new GenericContainer(TEST_IMAGES.nats)
    .withLabels({
      [TEST_CONTAINER_LABELS.marker]: 'true',
      [TEST_CONTAINER_LABELS.pid]: String(process.pid),
      [TEST_CONTAINER_LABELS.host]: hostname(),
    })
    .withCopyContentToContainer([
      { content: MQTT_NATS_CONFIG, target: '/etc/nats/mqtt.conf' },
    ])
    .withCommand(['-c', '/etc/nats/mqtt.conf'])
    .withExposedPorts(4222, 1883)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .withStartupTimeout(60_000)
    .start();
}

describe('fuel meters over MQTT (NATS MQTT gateway)', () => {
  let nats: StartedTestContainer | undefined;
  let service: TestService | undefined;
  let meter: MqttClient | undefined;
  const orgId = newOrgId();
  const [vessel] = uniqueMmsis(1) as [number];
  let deviceId: string;

  const started = (): TestService => {
    if (service === undefined) throw new Error('service not started');
    return service;
  };

  beforeAll(async () => {
    nats = await startMqttNats();
    service = await startTestService({
      natsUrl: `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`,
    });
    await service.publishVessel({ mmsi: vessel, orgId });
    const admin = await service.authorization({ roles: ['org_admin'], orgId });
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

    meter = await connectAsync(
      `mqtt://${nats.getHost()}:${nats.getMappedPort(1883)}`,
      {
        clientId: uniqueName('fuel-meter'),
        clean: true,
        connectTimeout: 10_000,
        reconnectPeriod: 0,
      },
    );
  });

  afterAll(async () => {
    await meter?.endAsync();
    await service?.close();
    await nats?.stop();
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
