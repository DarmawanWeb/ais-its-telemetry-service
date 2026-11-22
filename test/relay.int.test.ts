import { NatsClient, StreamManager } from '@darmawanweb/ais-its-nest/nats';
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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
      env: {
        TELEMETRY_RELAY_INTERVAL_MS: '200',
        TELEMETRY_RELAY_AFTER_S: '1',
        TELEMETRY_PUBLISH_TIMEOUT_MS: '1000',
      },
    });
    await service.publishVessel({ mmsi, orgId });
    await service.publishVessel({ mmsi: otherMmsi, orgId });
  });

  /**
   * Recreates the FUEL stream as a producer does at boot. The application's
   * StreamManager ensures each stream once per process, so a fresh one is used.
   */
  const recreateFuelStream = async () => {
    await new StreamManager(service.app.get(NatsClient)).ensure(
      ['FUEL'],
      'producer',
    );
  };

  afterAll(async () => {
    // Leave the shared NATS with its FUEL stream for the next test files.
    await recreateFuelStream();
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
    expect(response.json()).toEqual({
      received: 2,
      accepted: 2,
      duplicates: 0,
      published: 0,
    });
    expect(await pending()).toEqual(
      expect.arrayContaining([
        { mmsi, published: false },
        { mmsi: otherMmsi, published: false },
      ]),
    );

    // While the stream is missing the relay fails too: nothing is lost.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await pending()).toHaveLength(2);

    await recreateFuelStream();
    await waitFor(async () => (await pending()).length === 0, {
      timeoutMs: 15_000,
      message: 'relay did not republish',
    });

    const { rows } = await service.pool.query<{ published: boolean }>(
      'SELECT published_at IS NOT NULL AS published FROM fuel_readings WHERE mmsi = ANY($1)',
      [[mmsi, otherMmsi]],
    );
    expect(rows).toEqual([{ published: true }, { published: true }]);
    const [event] = await readFuelEvents(service.app, mmsi, 1);
    expect(event?.msgId).toBe(`${mmsi}:${time}`);
    expect(event?.envelope.data).toMatchObject({
      mmsi,
      fuelMeTon: 1.25,
      source: 'api',
    });

    const metrics = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metrics.body).toMatch(
      /aisits_telemetry_relayed_total\{outcome="published"\} 2/,
    );
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
    expect(
      events.filter((event) => event.msgId === `${mmsi}:${relayTime}`),
    ).toHaveLength(1);
  });

  it('marks a relayed reading of a compressed chunk without decompressing the other vessels', async () => {
    // Five vessels with a day of 15-minute readings in a chunk ~450 days old
    // (one compressed batch per vessel); one reading was never published.
    const vessels = uniqueMmsis(5);
    const [target] = vessels as [number];
    const day = Math.floor((Date.now() - 450 * DAY_MS) / DAY_MS) * DAY_MS;
    const unpublished = new Date(day + 12 * HOUR_MS).toISOString();
    await service.pool.query(
      `INSERT INTO fuel_readings (time, mmsi, fuel_me_ton, fuel_ae_ton, source, published_at)
       SELECT t, m, 0.1, 0.01, 'import', CASE WHEN m = $3 AND t = $4 THEN NULL ELSE now() END
       FROM unnest($1::integer[]) m,
            generate_series($2::timestamptz, $2::timestamptz + interval '1 day' - interval '15 minutes', interval '15 minutes') t`,
      [vessels, new Date(day).toISOString(), target, unpublished],
    );
    const { rows: chunks } = await service.pool.query<{ chunk: string }>(
      `SELECT compress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass)::text AS chunk
       FROM timescaledb_information.chunks
       WHERE hypertable_schema = 'telemetry' AND hypertable_name = 'fuel_readings'
         AND range_start <= $1 AND range_end > $1`,
      [unpublished],
    );
    const chunk = chunks[0]?.chunk ?? '';
    const uncompressedRows = async () =>
      Number(
        (
          await service.pool.query<{ count: string }>(
            `SELECT count(*) FROM ONLY ${chunk}`,
          )
        ).rows[0]?.count,
      );
    expect(await uncompressedRows()).toBe(0);

    // Queued as if its publication had failed a minute ago: the relay takes it.
    await service.pool.query(
      `INSERT INTO fuel_readings_unpublished (mmsi, time, received_at) VALUES ($1, $2, now() - interval '1 minute')`,
      [target, unpublished],
    );
    await waitFor(
      async () =>
        (
          await service.pool.query(
            'SELECT 1 FROM fuel_readings WHERE mmsi = $1 AND time = $2 AND published_at IS NOT NULL',
            [target, unpublished],
          )
        ).rowCount === 1,
      { timeoutMs: 15_000, message: 'relay did not mark the reading' },
    );

    // Only the target vessel's batch (96 readings) was decompressed to set
    // published_at; without the MMSI predicate it would be all five (480).
    expect(await uncompressedRows()).toBe(96);
    const [event] = await readFuelEvents(service.app, target, 1);
    expect(event?.msgId).toBe(`${target}:${unpublished}`);
  });
});
