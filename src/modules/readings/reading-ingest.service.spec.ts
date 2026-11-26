import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FuelReadingInput } from '../../domain/fuel-reading.js';
import type { NewReading, StoredReading } from './reading.js';
import { ReadingIngestService } from './reading-ingest.service.js';
import type { ReadingPublisher } from './reading-publisher.js';
import type { ReadingsRepository } from './readings.repository.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const DEVICE = '0193a0f2-0000-7000-8000-0000000000d1';

const reading = (iso: string, fuelMeTon = 1): FuelReadingInput => ({
  mmsi: 525005223,
  time: new Date(iso),
  periodStart: null,
  fuelMeTon,
  fuelAeTon: 0.1,
});

const asStored = (input: NewReading): StoredReading => ({
  ...input,
  receivedAt: NOW,
});

const attributed = (
  input: FuelReadingInput,
  deviceId: string | null = null,
): NewReading => ({ ...input, source: 'api', deviceId });

describe('ReadingIngestService', () => {
  const store = vi.fn<ReadingsRepository['store']>();
  const findStored = vi.fn<ReadingsRepository['findStored']>();
  const publishCommitted = vi.fn<ReadingPublisher['publishCommitted']>();
  let metrics: TelemetryMetrics;
  let service: ReadingIngestService;

  const counted = async (outcome: string): Promise<number> =>
    (await metrics.readings.get()).values
      .filter((value) => value.labels.outcome === outcome)
      .reduce((sum, value) => sum + value.value, 0);

  beforeEach(() => {
    vi.resetAllMocks();
    store.mockImplementation((window) =>
      Promise.resolve({
        stored: window.map(asStored),
        duplicates: [],
        conflicts: [],
        rejected: false,
      }),
    );
    findStored.mockResolvedValue([]);
    publishCommitted.mockImplementation((stored) =>
      Promise.resolve(stored.length),
    );
    metrics = new TelemetryMetrics(new MetricsService());
    service = new ReadingIngestService(
      { store, findStored } as unknown as ReadingsRepository,
      { publishCommitted } as unknown as ReadingPublisher,
      metrics,
      { now: () => NOW },
    );
  });

  it('stores each UTC day of a batch in its own transaction, oldest first', async () => {
    const batch = [
      reading('2026-11-21T08:00:00Z'),
      reading('2021-12-01T12:00:00Z'),
      reading('2026-11-21T09:00:00Z'),
      reading('2026-11-20T23:59:00Z'),
    ];

    const outcome = await service.ingest(
      { readings: batch, source: 'api', deviceId: null },
      'skip',
    );

    expect(
      store.mock.calls.map(([window]) =>
        window.map((r) => r.time.toISOString()),
      ),
    ).toEqual([
      ['2021-12-01T12:00:00.000Z'],
      ['2026-11-20T23:59:00.000Z'],
      ['2026-11-21T08:00:00.000Z', '2026-11-21T09:00:00.000Z'],
    ]);
    expect(store.mock.calls[0]?.[1]).toEqual({ rejectConflicts: false });
    expect(outcome).toEqual({
      received: 4,
      accepted: 4,
      duplicates: 0,
      conflicts: 0,
      // The newest measurement of the batch, whatever its order.
      latest: new Date('2026-11-21T09:00:00Z'),
      published: 4,
    });
    expect(publishCommitted).toHaveBeenCalledOnce();
    expect(await counted('accepted')).toBe(4);
  });

  it('drops exact repeats of the batch before storing', async () => {
    const repeated = reading('2026-11-21T08:00:00Z');
    const outcome = await service.ingest(
      { readings: [repeated, repeated], source: 'mqtt', deviceId: DEVICE },
      'skip',
    );
    expect(store.mock.calls[0]?.[0]).toHaveLength(1);
    expect(outcome).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('skip: stores the rest of the batch and reports the conflicting readings', async () => {
    const [kept, conflicting] = [
      reading('2026-11-21T08:00:00Z'),
      reading('2026-11-21T08:10:00Z'),
    ] as const;
    store.mockImplementation((window) =>
      Promise.resolve({
        stored: window.slice(0, 1).map(asStored),
        duplicates: [],
        conflicts: window.slice(1),
        rejected: false,
      }),
    );

    const outcome = await service.ingest(
      { readings: [kept, conflicting], source: 'mqtt', deviceId: DEVICE },
      'skip',
    );

    expect(outcome).toMatchObject({ accepted: 1, conflicts: 1, published: 1 });
    // The conflicting reading is another device's: not the newest of this one.
    expect(outcome.latest).toEqual(kept.time);
    expect(findStored).not.toHaveBeenCalled();
    expect(await counted('conflict')).toBe(1);
  });

  it('counts duplicates of the device in latest, and none when everything conflicted', async () => {
    const [resent, fresh] = [
      reading('2026-11-21T09:00:00Z'),
      reading('2026-11-21T08:00:00Z'),
    ] as const;
    store.mockImplementation((window) =>
      Promise.resolve({
        stored: window
          .filter((r) => r.time.getTime() === fresh.time.getTime())
          .map(asStored),
        duplicates: window.filter(
          (r) => r.time.getTime() === resent.time.getTime(),
        ),
        conflicts: [],
        rejected: false,
      }),
    );
    const outcome = await service.ingest(
      { readings: [resent, fresh], source: 'mqtt', deviceId: DEVICE },
      'skip',
    );
    expect(outcome).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(outcome.latest).toEqual(resent.time);

    store.mockImplementation((window) =>
      Promise.resolve({
        stored: [],
        duplicates: [],
        conflicts: [...window],
        rejected: false,
      }),
    );
    const conflicted = await service.ingest(
      { readings: [resent, fresh], source: 'mqtt', deviceId: DEVICE },
      'skip',
    );
    expect(conflicted).toMatchObject({ accepted: 0, conflicts: 2 });
    expect(conflicted.latest).toBeNull();
  });

  it('reject: compares a multi-day batch first and stores nothing on a conflict', async () => {
    const first = reading('2026-11-20T08:00:00Z');
    const taken = reading('2026-11-21T08:00:00Z');
    // The vessel's meter reported the same instant already.
    findStored.mockResolvedValue([asStored(attributed(taken, DEVICE))]);

    const outcome = await service.store(
      { readings: [first, taken], source: 'api', deviceId: null },
      'reject',
    );

    expect(outcome).toMatchObject({ rejected: true, stored: [], latest: null });
    expect(outcome.conflicts.map((r) => r.time)).toEqual([taken.time]);
    expect(store).not.toHaveBeenCalled();
    expect(await counted('conflict')).toBe(1);
  });

  it('reject: accepts repeats of the same measurement and device as duplicates', async () => {
    const resent = reading('2026-11-20T08:00:00Z');
    findStored.mockResolvedValue([asStored(attributed(resent, DEVICE))]);

    const outcome = await service.store(
      {
        readings: [resent, reading('2026-11-21T08:00:00Z')],
        source: 'device',
        deviceId: DEVICE,
      },
      'reject',
    );

    expect(outcome.rejected).toBe(false);
    expect(store).toHaveBeenCalledTimes(2);
    expect(store.mock.calls[0]?.[1]).toEqual({ rejectConflicts: true });
  });

  it('reject: stops at the window whose transaction found a conflict', async () => {
    const [day1, day2, day3] = [
      reading('2026-11-19T08:00:00Z'),
      reading('2026-11-20T08:00:00Z'),
      reading('2026-11-21T08:00:00Z'),
    ];
    // A concurrent writer stored a different reading of day 2 after the comparison.
    store
      .mockResolvedValueOnce({
        stored: [asStored(attributed(day1))],
        duplicates: [],
        conflicts: [],
        rejected: false,
      })
      .mockResolvedValueOnce({
        stored: [],
        duplicates: [],
        conflicts: [attributed(day2)],
        rejected: true,
      });

    const outcome = await service.store(
      { readings: [day1, day2, day3], source: 'api', deviceId: null },
      'reject',
    );

    expect(store).toHaveBeenCalledTimes(2);
    expect(outcome.rejected).toBe(true);
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.latest).toBeNull();
  });
});
