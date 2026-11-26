import { encodeCursor } from '@darmawanweb/ais-its-contracts/api';
import { loadConfig, ValidationFailedError } from '@darmawanweb/ais-its-nest';
import type { AuditService } from '@darmawanweb/ais-its-nest/audit';
import { ApiKeyPrincipal, UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { SanitizedDatabaseError } from '@darmawanweb/ais-its-nest/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceInactiveError,
  DeviceVesselMismatchError,
  ReadingConflictError,
  VesselAccessDeniedError,
  VesselNotFoundError,
} from '../../common/errors.js';
import { configSchema } from '../../config.js';
import type { FuelReadingInput } from '../../domain/fuel-reading.js';
import type { Device } from '../devices/device.js';
import type { DevicesService } from '../devices/devices.service.js';
import type { Vessel } from '../vessels/vessel.js';
import { VesselAccessService } from '../vessels/vessel-access.service.js';
import type { VesselsRepository } from '../vessels/vessels.repository.js';
import type { IngestBatch, NewReading, StoredReading } from './reading.js';
import type { ReadingIngestService } from './reading-ingest.service.js';
import type { ReadingsRepository, SeriesPoint } from './readings.repository.js';
import {
  ReadingsService,
  SERIES_EXPORT_BATCH_SIZE,
} from './readings.service.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const ORG = '0193a0f2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0193a0f2-0000-7000-8000-00000000000b';
const config = loadConfig(configSchema, {
  env: { LOG_LEVEL: 'silent' },
  envFile: false,
  output: null,
});

const vessel = (mmsi: number, orgId: string | null): Vessel => ({
  mmsi,
  vesselId: `0193a0f2-0000-7000-8000-${String(mmsi).padStart(12, '0')}`,
  orgId,
  name: `Vessel ${mmsi}`,
  status: 'active',
  sourceUpdatedAt: NOW,
  deletedAt: null,
});
const FLEET = [
  vessel(525005223, ORG),
  vessel(525005224, ORG),
  vessel(525009999, OTHER_ORG),
];

const reading = (
  mmsi: number,
  minute = 0,
  fuelMeTon = 0.4,
): FuelReadingInput => ({
  mmsi,
  time: new Date(Date.UTC(2026, 10, 21, 9, minute)),
  periodStart: null,
  fuelMeTon,
  fuelAeTon: 0.05,
});

const stored = (
  batch: IngestBatch,
  input: FuelReadingInput,
): StoredReading => ({
  ...input,
  source: batch.source,
  deviceId: batch.deviceId,
  receivedAt: NOW,
});

const user = (roles: UserPrincipal['roles'], orgId: string | null = ORG) =>
  new UserPrincipal({
    id: '0193a0f2-0000-7000-8000-0000000000u1',
    sessionId: 's',
    orgId,
    roles,
    email: 'u@x.io',
    name: 'U',
  });
const apiKey = new ApiKeyPrincipal({
  id: '0193a0f2-0000-7000-8000-0000000000k1',
  orgId: ORG,
  scopes: ['telemetry:ingest'],
  name: 'meter',
});

const device = (overrides: Partial<Device> = {}): Device => ({
  id: '0193a0f2-0000-7000-8000-0000000000d1',
  orgId: ORG,
  mmsi: 525005223,
  name: 'ME meter',
  kind: 'http',
  apiKeyId: apiKey.id,
  status: 'active',
  serialNumber: null,
  lastSeenAt: null,
  lastReadingAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('ReadingsService', () => {
  const store = vi.fn<ReadingIngestService['store']>();
  const publish = vi.fn<ReadingIngestService['publish']>();
  const deviceOfApiKey = vi.fn<DevicesService['deviceOfApiKey']>();
  const markSeen = vi.fn<DevicesService['markSeen']>();
  const record = vi.fn<AuditService['record']>();
  const latest = vi.fn<ReadingsRepository['latest']>();
  const pieceTotals = vi.fn<ReadingsRepository['pieceTotals']>();
  const series = vi.fn<ReadingsRepository['series']>();
  let service: ReadingsService;

  beforeEach(() => {
    vi.resetAllMocks();
    store.mockImplementation((batch: IngestBatch) =>
      Promise.resolve({
        received: batch.readings.length,
        stored: batch.readings.map((input) => stored(batch, input)),
        duplicates: 0,
        conflicts: [],
        rejected: false,
        latest: batch.readings.reduce<Date | null>(
          (newest, input) =>
            newest === null || input.time > newest ? input.time : newest,
          null,
        ),
      }),
    );
    publish.mockImplementation((readings) => Promise.resolve(readings.length));
    deviceOfApiKey.mockResolvedValue(undefined);
    record.mockResolvedValue(true);
    const findLive = (mmsis: readonly number[]) =>
      Promise.resolve(FLEET.filter((v) => mmsis.includes(v.mmsi)));
    service = new ReadingsService(
      { latest, pieceTotals, series } as unknown as ReadingsRepository,
      { store, publish } as unknown as ReadingIngestService,
      new VesselAccessService({ findLive } as unknown as VesselsRepository),
      { deviceOfApiKey, markSeen } as unknown as DevicesService,
      { record } as unknown as AuditService,
      config,
      { now: () => NOW },
    );
  });

  describe('ingest', () => {
    it('stores manual readings of a user and audits them per vessel', async () => {
      const readings = [
        reading(525005223),
        reading(525005223, 1),
        reading(525005224),
      ];

      const outcome = await service.ingest(
        readings,
        user(['fleet_manager']),
        undefined,
      );

      expect(outcome).toEqual({
        received: 3,
        accepted: 3,
        duplicates: 0,
        published: 3,
      });
      expect(store).toHaveBeenCalledWith(
        { readings, source: 'manual', deviceId: null },
        'reject',
      );
      expect(record).toHaveBeenCalledTimes(2);
      expect(record.mock.calls[0]?.[0]).toMatchObject({
        action: 'fuel_reading.create',
        targetType: 'vessel',
        orgId: ORG,
        meta: { mmsi: 525005223, readings: 2, source: 'manual' },
      });
    });

    it('lets users label historical imports', async () => {
      await service.ingest([reading(525005223)], user(['org_admin']), 'import');
      expect(store.mock.calls[0]?.[0].source).toBe('import');
    });

    it('rejects implausible readings with <index>.<field> errors before anything else', async () => {
      const error = await service
        .ingest(
          [reading(525005223), reading(999999999, 0, -2)],
          apiKey,
          undefined,
        )
        .catch((rejection: unknown) => rejection);

      expect(error).toBeInstanceOf(ValidationFailedError);
      expect((error as ValidationFailedError).errors).toEqual([
        {
          field: '1.fuelMeTon',
          message: 'fuelMeTon must not be negative',
          code: 'negative',
        },
      ]);
      expect(store).not.toHaveBeenCalled();
    });

    it('attributes readings of an API key without device to source api', async () => {
      await service.ingest([reading(525005223)], apiKey, undefined);
      expect(store.mock.calls[0]?.[0]).toMatchObject({
        source: 'api',
        deviceId: null,
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('attributes readings of a device key to the device and marks it seen', async () => {
      deviceOfApiKey.mockResolvedValue(device());
      await service.ingest(
        [reading(525005223, 5), reading(525005223, 15), reading(525005223)],
        apiKey,
        undefined,
      );
      expect(store.mock.calls[0]?.[0]).toMatchObject({
        source: 'device',
        deviceId: device().id,
      });
      // Received now; the newest reading the store holds for the device:
      // 09:15, stored on its vessel (lastReadingAt only while it stays there).
      expect(markSeen).toHaveBeenCalledWith(
        expect.objectContaining({ id: device().id, mmsi: 525005223 }),
        NOW,
        reading(525005223, 15).time,
      );
    });

    it('refuses keys of inactive devices and readings of other vessels', async () => {
      deviceOfApiKey.mockResolvedValue(device({ status: 'inactive' }));
      await expect(
        service.ingest([reading(525005223)], apiKey, undefined),
      ).rejects.toBeInstanceOf(DeviceInactiveError);

      deviceOfApiKey.mockResolvedValue(device());
      await expect(
        service.ingest(
          [reading(525005223), reading(525005224)],
          apiKey,
          undefined,
        ),
      ).rejects.toMatchObject({
        code: 'DEVICE_VESSEL_MISMATCH',
        extra: { mmsi: [525005224] },
      });
      await expect(
        service.ingest([reading(525005224)], apiKey, undefined),
      ).rejects.toBeInstanceOf(DeviceVesselMismatchError);
      expect(store).not.toHaveBeenCalled();
    });

    it('refuses a source chosen by an API key', async () => {
      await expect(
        service.ingest([reading(525005223)], apiKey, 'import'),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('rejects unknown vessels (404) and vessels of another organization (403)', async () => {
      await expect(
        service.ingest(
          [reading(525005223), reading(525000001), reading(525000002)],
          apiKey,
          undefined,
        ),
      ).rejects.toMatchObject({
        code: 'VESSEL_NOT_FOUND',
        status: 404,
        extra: { mmsi: [525000001, 525000002] },
      });
      await expect(
        service.ingest([reading(525009999)], apiKey, undefined),
      ).rejects.toBeInstanceOf(VesselAccessDeniedError);
      await expect(
        service.ingest(
          [reading(525009999)],
          user(['fleet_manager']),
          undefined,
        ),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      expect(store).not.toHaveBeenCalled();
    });

    it('lets platform administrators write telemetry of any organization', async () => {
      await service.ingest(
        [reading(525009999)],
        user(['super_admin'], null),
        undefined,
      );
      expect(store).toHaveBeenCalledOnce();
    });
  });

  describe('ingest: conflicts and the post-commit wait', () => {
    it('answers 409 READING_CONFLICT with the index of every conflicting reading', async () => {
      const taken = reading(525005223, 5);
      const readings = [reading(525005223), taken, reading(525005224, 5)];
      const conflicting: NewReading = {
        ...taken,
        source: 'device',
        deviceId: null,
      };
      store.mockResolvedValue({
        received: 3,
        stored: [],
        duplicates: 0,
        conflicts: [conflicting],
        rejected: true,
        latest: null,
      });

      const error = await service
        .ingest(readings, apiKey, undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ReadingConflictError);
      expect(error).toMatchObject({
        code: 'READING_CONFLICT',
        status: 409,
        errors: [
          {
            field: '1.time',
            message: `MMSI 525005223 has a different reading at ${taken.time.toISOString()} already`,
            code: 'conflict',
          },
        ],
      });
      expect(publish).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('writes the audit records concurrently with the publication and waits at most TELEMETRY_PUBLISH_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        // NATS stalls: neither the readings nor the audit records are acknowledged.
        const stalled = () => new Promise<never>(() => undefined);
        record.mockImplementation(stalled);
        // The publisher gives up after its JetStream timeout.
        publish.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve(0);
              }, config.TELEMETRY_PUBLISH_TIMEOUT_MS);
            }),
        );
        let answered = false;
        const pending = service
          .ingest(
            [reading(525005223), reading(525005224), reading(525005223, 1)],
            user(['fleet_manager']),
            undefined,
          )
          .then((outcome) => {
            answered = true;
            return outcome;
          });

        await vi.advanceTimersByTimeAsync(
          config.TELEMETRY_PUBLISH_TIMEOUT_MS - 1,
        );
        expect(answered).toBe(false);
        // Both vessels' records were started at once, not one after the other.
        expect(record).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({
          accepted: 3,
          published: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('status', () => {
    it('is active while the newest reading is within TELEMETRY_ACTIVE_WINDOW_MIN', async () => {
      const newest = {
        ...reading(525005223),
        time: new Date(NOW.getTime() - 9 * 60_000),
        source: 'api' as const,
        deviceId: null,
        receivedAt: NOW,
      };
      latest.mockResolvedValue(newest);
      await expect(service.status(525005223, apiKey)).resolves.toEqual({
        mmsi: 525005223,
        active: true,
        activeWindowMin: 10,
        lastReading: newest,
      });

      latest.mockResolvedValue({
        ...newest,
        time: new Date(NOW.getTime() - 11 * 60_000),
      });
      await expect(service.status(525005223, apiKey)).resolves.toMatchObject({
        active: false,
      });

      latest.mockResolvedValue(undefined);
      await expect(service.status(525005223, apiKey)).resolves.toMatchObject({
        active: false,
        lastReading: null,
      });
    });

    it('applies the tenancy rules', async () => {
      await expect(service.status(525000001, apiKey)).rejects.toBeInstanceOf(
        VesselNotFoundError,
      );
      await expect(service.status(525009999, apiKey)).rejects.toBeInstanceOf(
        VesselAccessDeniedError,
      );
    });
  });

  describe('summary', () => {
    it('sums the totals of the planned pieces', async () => {
      pieceTotals.mockResolvedValue([
        {
          readings: 2,
          fuelMeTon: 1,
          fuelAeTon: 0.1,
          firstReadingAt: new Date('2026-11-20T10:10:00Z'),
          lastReadingAt: new Date('2026-11-20T10:50:00Z'),
        },
        {
          readings: 0,
          fuelMeTon: 0,
          fuelAeTon: 0,
          firstReadingAt: null,
          lastReadingAt: null,
        },
        {
          readings: 3,
          fuelMeTon: 2.5,
          fuelAeTon: 0.2,
          firstReadingAt: new Date('2026-11-20T11:00:00Z'),
          lastReadingAt: new Date('2026-11-21T09:30:00Z'),
        },
      ]);

      const summary = await service.summary(
        525005223,
        { from: '2026-11-20T10:05:00Z', to: '2026-11-21T09:45:00Z' },
        apiKey,
      );

      expect(summary).toMatchObject({
        readings: 5,
        fuelMeTon: 3.5,
        firstReadingAt: new Date('2026-11-20T10:10:00Z'),
        lastReadingAt: new Date('2026-11-21T09:30:00Z'),
      });
      expect(summary.fuelAeTon).toBeCloseTo(0.3, 12);
      const [, pieces] = pieceTotals.mock.calls[0] ?? [];
      expect(pieces?.map((piece) => piece.source)).toEqual([
        'raw',
        '1h',
        'raw',
      ]);
    });

    it('defaults to the last 30 days', async () => {
      pieceTotals.mockResolvedValue([]);
      const summary = await service.summary(525005223, {}, apiKey);
      expect(summary.to).toEqual(NOW);
      expect(NOW.getTime() - summary.from.getTime()).toBe(30 * 86_400_000);
    });
  });

  /** A raw point `minutes` after 08:00 of NOW's day. */
  const point = (minutes: number): SeriesPoint => ({
    time: new Date(Date.UTC(2026, 10, 21, 8, minutes)),
    fuelMeTon: 0.4,
    fuelAeTon: 0.05,
    readings: 1,
    periodStart: null,
    source: 'api',
    deviceId: null,
  });
  const range = {
    from: '2026-11-21T00:00:00Z',
    to: '2026-11-21T10:00:00Z',
  } as const;

  describe('series', () => {
    it('pages newest first with order=desc and continues before the last point', async () => {
      const manager = user(['fleet_manager']);
      series.mockResolvedValueOnce([point(30), point(20), point(10)]);
      const first = await service.series(
        525005223,
        { ...range, bucket: 'raw', order: 'desc', limit: 2 },
        manager,
      );
      expect(series).toHaveBeenLastCalledWith(
        expect.objectContaining({ order: 'desc', after: undefined, limit: 3 }),
      );
      expect(first.data).toEqual([point(30), point(20)]);
      expect(first.page.nextCursor).toEqual(expect.any(String));

      series.mockResolvedValueOnce([point(10)]);
      const second = await service.series(
        525005223,
        {
          ...range,
          bucket: 'raw',
          order: 'desc',
          limit: 2,
          cursor: first.page.nextCursor ?? '',
        },
        manager,
      );
      expect(series).toHaveBeenLastCalledWith(
        expect.objectContaining({ order: 'desc', after: point(20).time }),
      );
      expect(second.page.nextCursor).toBeNull();
    });

    it('refuses a cursor of the other order (400) and reads cursors without an order as ascending', async () => {
      const manager = user(['fleet_manager']);
      series.mockResolvedValue([point(10), point(20)]);
      const ascending = await service.series(
        525005223,
        { ...range, bucket: 'raw', order: 'asc', limit: 1 },
        manager,
      );
      const cursor = ascending.page.nextCursor ?? '';
      await expect(
        service.series(
          525005223,
          { ...range, bucket: 'raw', order: 'desc', limit: 1, cursor },
          manager,
        ),
      ).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ field: 'cursor', code: 'isCursor' }),
        ],
      });

      // A cursor issued before `order` existed ({ b, t }) continues ascending.
      const legacy = encodeCursor({ b: 'raw', t: '2026-11-21T08:10:00.000Z' });
      await service.series(
        525005223,
        { ...range, bucket: 'raw', order: 'asc', limit: 1, cursor: legacy },
        manager,
      );
      expect(series).toHaveBeenLastCalledWith(
        expect.objectContaining({ order: 'asc', after: point(10).time }),
      );
      await expect(
        service.series(
          525005223,
          { ...range, bucket: 'raw', order: 'desc', limit: 1, cursor: legacy },
          manager,
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe('exportSeries', () => {
    const full = Array.from({ length: SERIES_EXPORT_BATCH_SIZE }, (_, index) =>
      point(index / 1000),
    );

    async function collect(
      batches: AsyncIterable<readonly SeriesPoint[]>,
    ): Promise<SeriesPoint[]> {
      const points: SeriesPoint[] = [];
      for await (const batch of batches) points.push(...batch);
      return points;
    }

    it('reads the first batch before streaming and the rest in keyset batches, ascending', async () => {
      series
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce([point(30), point(40)]);
      const exported = await service.exportSeries(
        525005223,
        { ...range, bucket: 'raw' },
        user(['fleet_manager']),
      );
      expect(exported).toMatchObject({
        mmsi: 525005223,
        bucket: 'raw',
        from: new Date(range.from),
        to: new Date(range.to),
      });
      // The first batch is read before the response starts (errors become problems).
      expect(series).toHaveBeenCalledTimes(1);
      expect(series).toHaveBeenLastCalledWith(
        expect.objectContaining({
          order: 'asc',
          after: undefined,
          limit: SERIES_EXPORT_BATCH_SIZE,
        }),
      );

      const points = await collect(exported.batches);
      expect(points).toHaveLength(SERIES_EXPORT_BATCH_SIZE + 2);
      expect(series).toHaveBeenCalledTimes(2);
      expect(series).toHaveBeenLastCalledWith(
        expect.objectContaining({ after: full.at(-1)?.time }),
      );
    });

    it('applies tenancy and the range limits of the bucket before reading anything', async () => {
      await expect(
        service.exportSeries(525009999, { bucket: 'raw' }, apiKey),
      ).rejects.toBeInstanceOf(VesselAccessDeniedError);
      await expect(
        service.exportSeries(
          525005223,
          { bucket: 'raw', from: '2026-10-01T00:00:00Z', to: range.to },
          apiKey,
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(series).not.toHaveBeenCalled();
    });

    it('ends the stream with a sanitized error when a later batch fails', async () => {
      const driverError = Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: '57014',
          severity: 'ERROR',
          detail: 'Key (mmsi)=(525005223) is secret',
        },
      );
      series.mockResolvedValueOnce(full).mockRejectedValueOnce(driverError);
      const exported = await service.exportSeries(
        525005223,
        { ...range, bucket: 'raw' },
        user(['fleet_manager']),
      );
      const failure: unknown = await collect(exported.batches).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SanitizedDatabaseError);
      expect(failure).toMatchObject({ code: '57014' });
      expect(JSON.stringify(failure)).not.toContain('secret');
    });
  });
});
