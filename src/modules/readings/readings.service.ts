import type {
  CursorPage,
  PageQuery,
  Paginated,
} from '@darmawanweb/ais-its-contracts/api';
import {
  IsoDateTimeSchema,
  pageOffset,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { InjectConfig, ValidationFailedError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type {
  ApiKeyPrincipal,
  Principal,
} from '@darmawanweb/ais-its-nest/auth';
import {
  cursorPage,
  decodeQueryCursor,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Inject, Injectable } from '@nestjs/common';
import * as z from 'zod';

import { CLOCK, type Clock } from '../../common/clock.js';
import {
  DeviceInactiveError,
  DeviceVesselMismatchError,
} from '../../common/errors.js';
import { type Config, readingLimitsOf } from '../../config.js';
import {
  addTotals,
  EMPTY_TOTALS,
  FUEL_BUCKETS,
  type FuelBucket,
  planSummaryPieces,
  SERIES_RANGES,
  SUMMARY_RANGE,
} from '../../domain/fuel-aggregation.js';
import {
  batchViolations,
  type FuelReadingInput,
  type FuelReadingSource,
  type ReadingLimits,
  type UserReadingSource,
} from '../../domain/fuel-reading.js';
import { isTelemetryActive } from '../../domain/telemetry-status.js';
import { DevicesService } from '../devices/devices.service.js';
import {
  tenantScopeOf,
  VesselAccessService,
} from '../vessels/vessel-access.service.js';
import type { Vessel } from '../vessels/vessel.js';
import type { TelemetryStatus } from './dto/status.dto.js';
import type { FuelSummary } from './dto/summary.dto.js';
import type { TelemetryVessel } from './dto/telemetry-vessel.dto.js';
import type { IngestOutcome } from './reading.js';
import { ReadingIngestService } from './reading-ingest.service.js';
import { ReadingsRepository, type SeriesPoint } from './readings.repository.js';

/** Position of a series page: the bucket and the time of its last point. */
const SeriesCursorSchema = z.object({
  b: z.enum(FUEL_BUCKETS),
  t: IsoDateTimeSchema,
});

/** A time range query (`from` / `to` ISO-8601, optional). */
export interface TimeRangeInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** A page query of a fuel series. */
export interface SeriesPageInput extends TimeRangeInput {
  readonly bucket: FuelBucket;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** Provenance of a batch posted over REST. */
interface Attribution {
  readonly source: FuelReadingSource;
  readonly deviceId: string | null;
}

/**
 * REST use cases of fuel readings: ingestion by API keys (`telemetry:ingest`)
 * and users (`telemetry:write`) with validation, device attribution and
 * tenancy; series, summaries, status and the per-vessel overview
 * (`telemetry:read`). Tenancy always comes from the FLEET projection.
 */
@Injectable()
export class ReadingsService {
  private readonly limits: ReadingLimits;

  constructor(
    private readonly repository: ReadingsRepository,
    private readonly ingestion: ReadingIngestService,
    private readonly vessels: VesselAccessService,
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
    @InjectConfig() private readonly config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.limits = readingLimitsOf(config);
  }

  /**
   * Validates, attributes and stores a batch posted over REST; everything
   * is checked before anything is stored (all or nothing).
   *
   * @throws {ValidationFailedError} `400` with `<index>.<field>` errors for implausible readings.
   * @throws {DeviceInactiveError} `403` for the key of an inactive device.
   * @throws {DeviceVesselMismatchError} `403` when a device key reports another vessel.
   * @throws {VesselNotFoundError} `404` for MMSIs that are not vessels of the fleet.
   * @throws {VesselAccessDeniedError} `403` for vessels of another organization.
   */
  async ingest(
    readings: readonly FuelReadingInput[],
    principal: Principal,
    requestedSource: UserReadingSource | undefined,
    request?: AuditRequest,
  ): Promise<IngestOutcome> {
    const now = this.clock.now();
    const violations = batchViolations(readings, this.limits, now);
    if (violations.length > 0) {
      throw new ValidationFailedError(
        violations.map((violation) => ({
          field: `${violation.index}.${violation.field}`,
          message: violation.message,
          code: violation.code,
        })),
      );
    }

    const attribution =
      principal.kind === 'api_key'
        ? await this.attributeApiKey(principal, readings, requestedSource)
        : { source: requestedSource ?? 'manual', deviceId: null };
    const vessels = await this.vessels.accessible(
      readings.map((reading) => reading.mmsi),
      principal,
    );
    const outcome = await this.ingestion.ingest({ readings, ...attribution });

    if (attribution.deviceId !== null)
      await this.devices.markSeen(attribution.deviceId, now);
    if (principal.kind === 'user') {
      await this.auditManualEntry(
        readings,
        vessels,
        attribution.source,
        principal,
        request,
      );
    }
    return outcome;
  }

  /** One page of a vessel's readings or bucket sums, ascending in time. */
  async series(
    mmsi: number,
    query: SeriesPageInput,
    principal: Principal,
  ): Promise<CursorPage<SeriesPoint>> {
    await this.vessels.accessibleOne(mmsi, principal);
    const range = SERIES_RANGES[query.bucket];
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: range.defaultMs,
      maxDurationMs: range.maxMs,
      now: this.clock.now(),
    });
    const cursor = decodeQueryCursor(query, SeriesCursorSchema);
    if (cursor !== undefined && cursor.b !== query.bucket) {
      throw new ValidationFailedError([
        {
          field: 'cursor',
          message: `the cursor belongs to bucket=${cursor.b}`,
          code: 'isCursor',
        },
      ]);
    }
    const rows = await this.repository.series({
      mmsi,
      bucket: query.bucket,
      from,
      to,
      after: cursor === undefined ? undefined : new Date(cursor.t),
      limit: query.limit + 1,
    });
    return cursorPage(rows, query.limit, (last) => ({
      b: query.bucket,
      t: last.time.toISOString(),
    }));
  }

  /**
   * Totals of a vessel's readings with `time` in `[from, to)`: whole UTC
   * days from `fuel_daily`, whole hours from `fuel_hourly`, edges from the
   * raw readings (exactly the sum over the raw readings).
   */
  async summary(
    mmsi: number,
    query: TimeRangeInput,
    principal: Principal,
  ): Promise<FuelSummary> {
    await this.vessels.accessibleOne(mmsi, principal);
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: SUMMARY_RANGE.defaultMs,
      maxDurationMs: SUMMARY_RANGE.maxMs,
      now: this.clock.now(),
    });
    const totals = await this.repository.pieceTotals(
      mmsi,
      planSummaryPieces(from, to),
    );
    return { mmsi, from, to, ...totals.reduce(addTotals, EMPTY_TOTALS) };
  }

  /** Whether the vessel's telemetry is active and its newest reading. */
  async status(mmsi: number, principal: Principal): Promise<TelemetryStatus> {
    await this.vessels.accessibleOne(mmsi, principal);
    const lastReading = (await this.repository.latest(mmsi)) ?? null;
    return {
      mmsi,
      active: this.isActive(lastReading?.time ?? null),
      activeWindowMin: this.config.TELEMETRY_ACTIVE_WINDOW_MIN,
      lastReading,
    };
  }

  /** The principal's vessels with their newest reading, active flag and devices. */
  async vesselOverview(
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<TelemetryVessel>> {
    const { rows, total } = await this.repository.vesselOverview(
      tenantScopeOf(principal),
      {
        offset: pageOffset(page),
        limit: page.pageSize,
      },
    );
    return toPaginated(
      rows.map((row) => ({ ...row, active: this.isActive(row.lastReadingAt) })),
      page,
      total,
    );
  }

  private isActive(lastReadingAt: Date | null): boolean {
    return isTelemetryActive(
      lastReadingAt,
      this.clock.now(),
      this.config.TELEMETRY_ACTIVE_WINDOW_MIN,
    );
  }

  /**
   * API keys: readings of the key of a registered device are attributed to
   * it (source `device`), which must be active and report its own vessel;
   * other keys post as `api`. Only users choose a source.
   */
  private async attributeApiKey(
    principal: ApiKeyPrincipal,
    readings: readonly FuelReadingInput[],
    requestedSource: UserReadingSource | undefined,
  ): Promise<Attribution> {
    if (requestedSource !== undefined) {
      throw new ValidationFailedError([
        {
          field: 'source',
          message:
            'only signed-in users choose the source; API keys are attributed automatically',
          code: 'forbidden',
        },
      ]);
    }
    const device = await this.devices.deviceOfApiKey(principal);
    if (device === undefined) return { source: 'api', deviceId: null };
    if (device.status !== 'active') throw new DeviceInactiveError(device.id);
    const foreign = [
      ...new Set(
        readings
          .map((reading) => reading.mmsi)
          .filter((mmsi) => mmsi !== device.mmsi),
      ),
    ];
    if (foreign.length > 0)
      throw new DeviceVesselMismatchError(device.id, device.mmsi, foreign);
    return { source: 'device', deviceId: device.id };
  }

  /** One audit record per vessel for readings entered by a user. */
  private async auditManualEntry(
    readings: readonly FuelReadingInput[],
    vessels: ReadonlyMap<number, Vessel>,
    source: FuelReadingSource,
    principal: Principal,
    request: AuditRequest | undefined,
  ): Promise<void> {
    const counts = new Map<number, number>();
    for (const reading of readings)
      counts.set(reading.mmsi, (counts.get(reading.mmsi) ?? 0) + 1);
    for (const [mmsi, count] of counts) {
      const vessel = vessels.get(mmsi);
      await this.audit.record(
        {
          action: 'fuel_reading.create',
          targetType: 'vessel',
          targetId: vessel?.vesselId ?? null,
          orgId: vessel?.orgId ?? null,
          meta: { mmsi, readings: count, source },
        },
        principal,
        request,
      );
    }
  }
}
