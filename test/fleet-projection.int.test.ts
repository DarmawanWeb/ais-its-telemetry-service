import { randomUUID } from 'node:crypto';

import {
  EVENT_TYPES,
  type VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  newOrgId,
  startTestService,
  type TestService,
  uniqueMmsis,
} from './support/test-service.js';

/**
 * The FLEET projection (`telemetry-fleet` → `telemetry.vessels`) decides the
 * tenancy of every reading: these tests drive it with fleet events and
 * observe the effect on ingestion.
 */
describe('FLEET projection and tenancy', () => {
  let service: TestService;
  const orgA = newOrgId();
  const orgB = newOrgId();
  const [moving, deleted, renumberedOld, renumberedNew, marker] = uniqueMmsis(
    5,
  ) as [number, number, number, number, number];
  let readingMinute = 0;
  let movingSnapshot: VesselSnapshotV1;

  /** Posts one fresh reading with an API key of `orgId`; returns the status code and body. */
  const ingest = async (mmsi: number, orgId: string) => {
    readingMinute += 1;
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/v2/telemetry/readings',
      headers: service.apiKey(orgId).headers,
      payload: {
        mmsi,
        time: new Date(Date.now() - readingMinute * 60_000).toISOString(),
        fuelMeTon: 1,
        fuelAeTon: 0.1,
      },
    });
    return {
      status: response.statusCode,
      body: response.json<{ code?: string }>(),
    };
  };

  const projected = async (mmsi: number) =>
    (
      await service.pool.query<{ org_id: string | null; deleted: boolean }>(
        'SELECT org_id, deleted_at IS NOT NULL AS deleted FROM vessels WHERE mmsi = $1',
        [mmsi],
      )
    ).rows[0];

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.close();
  });

  it('follows ownership changes of a vessel', async () => {
    const snapshot = await service.publishVessel({ mmsi: moving, orgId: orgA });
    expect((await ingest(moving, orgA)).status).toBe(202);

    movingSnapshot = await service.publishVessel({
      ...snapshot,
      orgId: orgB,
      updatedAt: new Date(Date.parse(snapshot.updatedAt) + 1000).toISOString(),
    });
    expect(await ingest(moving, orgA)).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect((await ingest(moving, orgB)).status).toBe(202);
  });

  it('ignores snapshots older than the stored state (redeliveries in any order)', async () => {
    const current = await projected(moving);
    expect(current).toEqual({ org_id: orgB, deleted: false });

    // An older snapshot that still names orgA arrives late …
    await service.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, {
        ...movingSnapshot,
        orgId: orgA,
        updatedAt: new Date(
          Date.parse(movingSnapshot.updatedAt) - 1000,
        ).toISOString(),
      });
    // … the consumer handles events in order, so once a later one is
    // projected the late one was processed (and ignored).
    await service.publishVessel({ mmsi: marker, orgId: orgA });
    expect(await projected(moving)).toEqual({ org_id: orgB, deleted: false });
  });

  it('rejects readings of deleted vessels with VESSEL_NOT_FOUND until they come back', async () => {
    const snapshot = await service.publishVessel({
      mmsi: deleted,
      orgId: orgA,
    });
    expect((await ingest(deleted, orgA)).status).toBe(202);

    await service.deleteVessel(snapshot);
    expect(await ingest(deleted, orgA)).toMatchObject({
      status: 404,
      body: { code: 'VESSEL_NOT_FOUND' },
    });
    const reader = await service.authorization({
      roles: ['fleet_manager'],
      orgId: orgA,
    });
    const status = await service.app.inject({
      method: 'GET',
      url: `/api/v2/telemetry/vessels/${deleted}/status`,
      headers: reader,
    });
    expect(status.statusCode).toBe(404);

    // A snapshot newer than the stored one but older than the deletion does
    // not resurrect the vessel (the tombstone keeps the deletion time) …
    await service.app
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, {
        ...snapshot,
        updatedAt: new Date(Date.parse(snapshot.updatedAt) + 1).toISOString(),
      });
    await service.publishVessel({
      mmsi: marker,
      orgId: orgA,
      updatedAt: new Date().toISOString(),
    });
    expect(await projected(deleted)).toMatchObject({ deleted: true });

    // … a newer one (the vessel was restored in the fleet service) does.
    await service.publishVessel({
      ...snapshot,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect((await ingest(deleted, orgA)).status).toBe(202);
  });

  it('moves a vessel to its new MMSI', async () => {
    const id = randomUUID();
    const snapshot = await service.publishVessel({
      id,
      mmsi: renumberedOld,
      orgId: orgA,
    });
    await service.publishVessel({
      ...snapshot,
      mmsi: renumberedNew,
      updatedAt: new Date(Date.parse(snapshot.updatedAt) + 1000).toISOString(),
    });

    expect(await projected(renumberedOld)).toBeUndefined();
    expect(await ingest(renumberedOld, orgA)).toMatchObject({
      status: 404,
      body: { code: 'VESSEL_NOT_FOUND' },
    });
    expect((await ingest(renumberedNew, orgA)).status).toBe(202);
  });
});
