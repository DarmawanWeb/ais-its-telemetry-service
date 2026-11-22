import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import {
  TEST_CONTAINER_LABELS,
  TEST_IMAGES,
} from '@darmawanweb/ais-its-nest/testing';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

const docker = promisify(execFile);

/** Publish timeout of this file's service, ms (short to keep the test fast). */
const PUBLISH_TIMEOUT_MS = 1000;

/**
 * A NATS server of this file only: `docker pause` freezes it with its TCP
 * connections open, so publishes neither fail fast nor get acknowledged —
 * a stalled server, unlike a stopped one. Labelled like the kit's test
 * containers so `reapOrphanedTestContainers()` also removes it.
 */
async function startOwnNats(): Promise<StartedTestContainer> {
  return new GenericContainer(TEST_IMAGES.nats)
    .withLabels({
      [TEST_CONTAINER_LABELS.marker]: 'true',
      [TEST_CONTAINER_LABELS.pid]: String(process.pid),
      [TEST_CONTAINER_LABELS.host]: hostname(),
    })
    .withCommand(['-js'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .withStartupTimeout(60_000)
    .start();
}

describe('ingest while NATS stalls', () => {
  let nats: StartedTestContainer | undefined;
  let service: TestService | undefined;
  const orgId = newOrgId();
  const vessels = uniqueMmsis(3);

  const pause = async (paused: boolean) => {
    if (nats === undefined) return;
    await docker('docker', [paused ? 'pause' : 'unpause', nats.getId()]);
  };

  beforeAll(async () => {
    nats = await startOwnNats();
    service = await startTestService({
      natsUrl: `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`,
      env: {
        TELEMETRY_PUBLISH_TIMEOUT_MS: String(PUBLISH_TIMEOUT_MS),
        TELEMETRY_RELAY_INTERVAL_MS: '0',
      },
    });
    for (const mmsi of vessels) await service.publishVessel({ mmsi, orgId });
  });

  afterAll(async () => {
    await pause(false).catch(() => undefined);
    await service?.close();
    await nats?.stop();
  });

  it('answers a user within TELEMETRY_PUBLISH_TIMEOUT_MS, audit records of several vessels included', async () => {
    if (service === undefined) throw new Error('service not started');
    const manager = await service.authorization({
      roles: ['fleet_manager'],
      orgId,
    });
    const time = new Date(Date.now() - 60_000).toISOString();

    await pause(true);
    let elapsedMs: number;
    let body: unknown;
    try {
      const started = performance.now();
      const response = await service.app.inject({
        method: 'POST',
        url: '/api/v2/telemetry/readings',
        headers: manager,
        payload: vessels.map((mmsi) => ({
          mmsi,
          time,
          fuelMeTon: 0.5,
          fuelAeTon: 0.1,
        })),
      });
      elapsedMs = performance.now() - started;
      body = response.json();
    } finally {
      await pause(false);
    }

    expect(body).toEqual({
      received: 3,
      accepted: 3,
      duplicates: 0,
      published: 0,
    });
    // It waited for the publication, not for three audit publishes in a row
    // with the kit's 10 s JetStream timeout each (31 s before the fix).
    expect(elapsedMs).toBeGreaterThanOrEqual(PUBLISH_TIMEOUT_MS - 50);
    expect(elapsedMs).toBeLessThan(PUBLISH_TIMEOUT_MS + 2000);

    // Nothing is lost: the readings wait for the relay.
    const { rows } = await service.pool.query<{ mmsi: number }>(
      'SELECT mmsi FROM fuel_readings_unpublished WHERE mmsi = ANY($1) ORDER BY mmsi',
      [vessels],
    );
    expect(rows.map((row) => row.mmsi)).toEqual(vessels);
  });
});
