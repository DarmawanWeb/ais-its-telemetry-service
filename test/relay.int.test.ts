import { StreamManager } from '@darmawanweb/ais-its-nest/nats';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReadingRelay } from '../src/modules/readings/reading-relay.js';
import { readFuelEvents } from './support/fuel-events.js';
import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

/**
 * Reliable publication: a reading stored while the FUEL stream cannot take
 * it (here: the stream is deleted, so JetStream has no responder) stays
 * queued with published_at = NULL, and the relay republishes it once the
 * stream is back and the grace period passed.
 */
describe('publication relay', () => {
  let service: TestService;
  const orgId = newOrgId();
  const [mmsi, otherMmsi] = uniqueMmsis(2) as [number, number];
  const time = new Date(Date.now() - 60_000).toISOString();

  const pending = async () =>
    (
      await service.pool.query<{ mmsi: number; published: boolean }>(
        `SELECT r.mmsi, r.published_at IS NOT NULL AS published
         FROM fuel_readings r
         JOIN fuel_readings_unpublished u ON u.mmsi = r.mmsi AND u.time = r.time
         WHERE r.mmsi = ANY($1)`,
        [[mmsi, otherMmsi]],
      )
    ).rows;

  beforeAll(async () => {
    service = await startTestService({
      env: { TELEMETRY_RELAY_INTERVAL_MS: '200', TELEMETRY_RELAY_AFTER_S: '1', TELEMETRY_PUBLISH_TIMEOUT_MS: '1000' },
    });
    await service.publishVessel({ mmsi, orgId });
    await service.publishVessel({ mmsi: otherMmsi, orgId });
  });

  afterAll(async () => {
    // Leave the shared NATS with its FUEL stream for the next test files.
    await service.app.get(StreamManager).ensure(['FUEL'], 'producer');
    await service.close();
  });

  it('keeps readings queued while publishing fails and republishes them afterwards', async () => {
    const { manager } = await service.app.get(NatsClient).ready();
    await manager.streams.delete('FUEL');

    const key = service.apiKey(orgId);
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/v2/telemetry/readings',
      headers: key.headers,
      payload: [
        { mmsi, time, fuelMeTon: 1.25, fuelAeTon: 0.25 },
        { mmsi: otherMmsi, time, fuelMeTon: 2.5, fuelAeTon: 0.5 },
      ],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ received: 2, accepted: 2, duplicates: 0, published: 0 });
    expect(await pending()).toEqual(
      expect.arrayContaining([
        { mmsi, published: false },
        { mmsi: otherMmsi, published: false },
      ]),
    );

    // While the stream is missing the relay fails too: nothing is lost.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await pending()).toHaveLength(2);

    await service.app.get(StreamManager).ensure(['FUEL'], 'producer');
    await waitFor(async () => (await pending()).length === 0, { timeoutMs: 15_000, message: 'relay did not republish' });

    const { rows } = await service.pool.query<{ published: boolean }>(
      'SELECT published_at IS NOT NULL AS published FROM fuel_readings WHERE mmsi = ANY($1)',
      [[mmsi, otherMmsi]],
    );
    expect(rows).toEqual([{ published: true }, { published: true }]);
    const [event] = await readFuelEvents(service.app, mmsi, 1);
    expect(event?.msgId).toBe(`${mmsi}:${time}`);
    expect(event?.envelope.data).toMatchObject({ mmsi, fuelMeTon: 1.25, source: 'api' });

    const metrics = await service.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/aisits_telemetry_relayed_total\{outcome="published"\} 2/);
  });

  it('republishes with the same Nats-Msg-Id, so a second relay pass stores no duplicate', async () => {
    const relayTime = new Date(Date.now() - 120_000).toISOString();
    await service.pool.query(
      `INSERT INTO fuel_readings (time, mmsi, fuel_me_ton, fuel_ae_ton, source, received_at, published_at)
       VALUES ($1, $2, 3, 0.3, 'api', now() - interval '1 minute', now())`,
      [relayTime, mmsi],
    );
    // Simulate a crash after publishing but before marking: queue it twice.
    for (let pass = 0; pass < 2; pass += 1) {
      await service.pool.query(
        `INSERT INTO fuel_readings_unpublished (mmsi, time, received_at) VALUES ($1, $2, now() - interval '1 minute')`,
        [mmsi, relayTime],
      );
      const result = await service.app.get(ReadingRelay).relayOnce();
      expect(result).toMatchObject({ skipped: false });
      await waitFor(async () => (await pending()).length === 0);
    }
    const events = await readFuelEvents(service.app, mmsi, 3, 1500);
    expect(events.filter((event) => event.msgId === `${mmsi}:${relayTime}`)).toHaveLength(1);
  });
});
