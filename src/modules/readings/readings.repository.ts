import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import {
  type AggregateBucket,
  EMPTY_TOTALS,
  type FuelBucket,
  type FuelTotals,
  type SummaryPiece,
} from '../../domain/fuel-aggregation.js';
import type { FuelReadingSource } from '../../domain/fuel-reading.js';
import type { TenantScope } from '../vessels/vessel.js';
import type { NewReading, StoredReading } from './reading.js';

const {
  devices,
  fuelDaily,
  fuelHourly,
  fuelReadings,
  fuelReadingsUnpublished,
  vessels,
} = schema;

/** A point of a fuel series: a raw reading or the sums of a UTC bucket. */
export interface SeriesPoint {
  /** Reading time, or bucket start. */
  readonly time: Date;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  /** 1 for a raw reading, the number of readings of a bucket. */
  readonly readings: number;
  /** Raw readings only (`null` for buckets). */
  readonly periodStart: Date | null;
  readonly source: FuelReadingSource | null;
  readonly deviceId: string | null;
}

/** A query of a fuel series page (`limit` rows after `after`, ascending). */
export interface SeriesQuery {
  readonly mmsi: number;
  readonly bucket: FuelBucket;
  readonly from: Date;
  readonly to: Date;
  /** Exclusive lower bound of the page (cursor position). */
  readonly after: Date | undefined;
  readonly limit: number;
}

/** A vessel of the telemetry overview. */
export interface TelemetryVesselRow {
  readonly mmsi: number;
  readonly vesselId: string;
  readonly orgId: string | null;
  readonly name: string;
  readonly status: 'active' | 'inactive' | 'laid_up';
  readonly lastReadingAt: Date | null;
  readonly devices: number;
}

/** Backlog of the publication relay. */
export interface PublicationBacklog {
  readonly pending: number;
  /** Age of the oldest queued reading, s (0 when the queue is empty). */
  readonly oldestAgeSeconds: number;
}

/** Outcome of one relay transaction. */
export interface RelayBatchResult {
  readonly claimed: number;
  readonly published: number;
  /** Queue rows whose reading no longer exists (dropped by retention). */
  readonly orphaned: number;
}

/** The key of a stored reading. */
type ReadingKeyed = Pick<StoredReading, 'mmsi' | 'time'>;

/** A database handle or an open transaction. */
type Executor = Pick<
  Database<typeof schema>,
  'execute' | 'insert' | 'select' | 'delete'
>;

/**
 * Access to `fuel_readings`, its publication queue and the continuous
 * aggregates. Bulk statements bind arrays (`unnest`) so that a batch of
 * 1 000 readings costs a constant number of parameters, and bound the time
 * range so that TimescaleDB prunes chunks at plan time.
 */
@Injectable()
export class ReadingsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Stores new readings and queues them for publication in one transaction;
   * readings whose `(mmsi, time)` exists already are skipped (idempotent).
   *
   * @returns the readings stored by this call.
   */
  async insert(readings: readonly NewReading[]): Promise<StoredReading[]> {
    if (readings.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const stored = await tx
        .insert(fuelReadings)
        .values(
          readings.map((reading) => ({
            time: reading.time,
            mmsi: reading.mmsi,
            deviceId: reading.deviceId,
            periodStart: reading.periodStart,
            fuelMeTon: reading.fuelMeTon,
            fuelAeTon: reading.fuelAeTon,
            source: reading.source,
          })),
        )
        .onConflictDoNothing({ target: [fuelReadings.mmsi, fuelReadings.time] })
        .returning(storedColumns);
      if (stored.length > 0) {
        await tx.insert(fuelReadingsUnpublished).values(
          stored.map((reading) => ({
            mmsi: reading.mmsi,
            time: reading.time,
            receivedAt: reading.receivedAt,
          })),
        );
      }
      return stored;
    });
  }

  /** Marks readings as stored in the FUEL stream and dequeues them (one transaction). */
  async markPublished(readings: readonly ReadingKeyed[]): Promise<void> {
    if (readings.length === 0) return;
    await this.db.transaction((tx) => markPublishedWith(tx, readings));
  }

  /**
   * One relay step in one transaction: locks up to `limit` queued readings
   * stored at least `olderThanS` seconds ago (`FOR UPDATE SKIP LOCKED`, so
   * concurrent replicas share the backlog), hands them to `publish`, then
   * marks the published ones and drops queue rows without a reading.
   */
  async relayBatch(
    options: { readonly olderThanS: number; readonly limit: number },
    publish: (readings: StoredReading[]) => Promise<readonly StoredReading[]>,
  ): Promise<RelayBatchResult> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .select({
          mmsi: fuelReadingsUnpublished.mmsi,
          time: fuelReadingsUnpublished.time,
        })
        .from(fuelReadingsUnpublished)
        .where(
          lte(
            fuelReadingsUnpublished.receivedAt,
            sql`now() - make_interval(secs => ${options.olderThanS})`,
          ),
        )
        .orderBy(asc(fuelReadingsUnpublished.receivedAt))
        .limit(options.limit)
        .for('update', { skipLocked: true });
      if (claimed.length === 0)
        return { claimed: 0, published: 0, orphaned: 0 };

      const readings = await selectByKeys(tx, claimed);
      const found = new Set(readings.map(keyOf));
      const orphans = claimed.filter((key) => !found.has(keyOf(key)));
      const published = await publish(readings);
      await markPublishedWith(tx, [...published, ...orphans]);
      return {
        claimed: claimed.length,
        published: published.length,
        orphaned: orphans.length,
      };
    });
  }

  /** Size and age (database clock) of the publication queue. */
  async backlog(): Promise<PublicationBacklog> {
    const [row] = await this.db
      .select({
        pending: count(),
        oldestAgeSeconds: sql<number>`coalesce(extract(epoch FROM now() - min(${fuelReadingsUnpublished.receivedAt})), 0)::double precision`,
      })
      .from(fuelReadingsUnpublished);
    return {
      pending: row?.pending ?? 0,
      oldestAgeSeconds: Math.max(0, row?.oldestAgeSeconds ?? 0),
    };
  }

  /** The newest reading of a vessel (by measurement time). */
  async latest(mmsi: number): Promise<StoredReading | undefined> {
    const [row] = await this.db
      .select(storedColumns)
      .from(fuelReadings)
      .where(eq(fuelReadings.mmsi, mmsi))
      .orderBy(desc(fuelReadings.time))
      .limit(1);
    return row;
  }

  /** One page of a fuel series in ascending time order (fetch `limit + 1` to detect more). */
  async series(query: SeriesQuery): Promise<SeriesPoint[]> {
    if (query.bucket === 'raw') {
      const rows = await this.db
        .select(storedColumns)
        .from(fuelReadings)
        .where(
          and(
            eq(fuelReadings.mmsi, query.mmsi),
            gte(fuelReadings.time, query.from),
            lt(fuelReadings.time, query.to),
            query.after === undefined
              ? undefined
              : gt(fuelReadings.time, query.after),
          ),
        )
        .orderBy(asc(fuelReadings.time))
        .limit(query.limit);
      return rows.map((row) => ({
        time: row.time,
        fuelMeTon: row.fuelMeTon,
        fuelAeTon: row.fuelAeTon,
        readings: 1,
        periodStart: row.periodStart,
        source: row.source,
        deviceId: row.deviceId,
      }));
    }
    const view = aggregateView(query.bucket);
    const rows = await this.db
      .select({
        bucket: view.bucket,
        fuelMeTon: view.fuelMeTon,
        fuelAeTon: view.fuelAeTon,
        readings: sql<number>`${view.readings}::integer`,
      })
      .from(view)
      .where(
        and(
          eq(view.mmsi, query.mmsi),
          gte(view.bucket, query.from),
          lt(view.bucket, query.to),
          query.after === undefined ? undefined : gt(view.bucket, query.after),
        ),
      )
      .orderBy(asc(view.bucket))
      .limit(query.limit);
    return rows.map((row) => ({
      time: row.bucket,
      fuelMeTon: row.fuelMeTon,
      fuelAeTon: row.fuelAeTon,
      readings: row.readings,
      periodStart: null,
      source: null,
      deviceId: null,
    }));
  }

  /**
   * The totals of each summary piece (one statement, `UNION ALL`): raw
   * pieces from `fuel_readings`, aligned ones from the continuous aggregates.
   */
  async pieceTotals(
    mmsi: number,
    pieces: readonly SummaryPiece[],
  ): Promise<FuelTotals[]> {
    if (pieces.length === 0) return [];
    const parts = pieces.map((piece) => pieceTotalsQuery(mmsi, piece));
    const result = await this.db.execute<{
      readings: number;
      fuel_me_ton: number | null;
      fuel_ae_ton: number | null;
      first_time: Date | string | null;
      last_time: Date | string | null;
    }>(sql.join(parts, sql` UNION ALL `));
    return result.rows.map((row) =>
      row.readings === 0
        ? EMPTY_TOTALS
        : {
            readings: row.readings,
            fuelMeTon: row.fuel_me_ton ?? 0,
            fuelAeTon: row.fuel_ae_ton ?? 0,
            firstReadingAt: asNullableDate(row.first_time),
            lastReadingAt: asNullableDate(row.last_time),
          },
    );
  }

  /** The vessels of the scope with their newest reading and number of devices, by MMSI. */
  async vesselOverview(
    scope: TenantScope,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ rows: TelemetryVesselRow[]; total: number }> {
    const where = and(
      isNull(vessels.deletedAt),
      scope.kind === 'all' ? undefined : eq(vessels.orgId, scope.orgId),
    );
    // Correlated lateral subqueries in plain SQL (aliases, no column
    // interpolation: drizzle renders select-list columns unqualified).
    const tenant =
      scope.kind === 'all' ? sql`` : sql`AND v.org_id = ${scope.orgId}`;
    const [result, totals] = await Promise.all([
      this.db.execute<{
        mmsi: number;
        vessel_id: string;
        org_id: string | null;
        name: string;
        status: TelemetryVesselRow['status'];
        last_reading_at: Date | string | null;
        devices: number;
      }>(sql`
        SELECT v.mmsi, v.vessel_id, v.org_id, v.name, v.status,
               last.time AS last_reading_at, d.devices
        FROM ${vessels} v
        LEFT JOIN LATERAL (
          SELECT r.time FROM ${fuelReadings} r
          WHERE r.mmsi = v.mmsi ORDER BY r.time DESC LIMIT 1
        ) last ON true
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS devices FROM ${devices} dv
          WHERE dv.org_id = v.org_id AND dv.mmsi = v.mmsi
        ) d
        WHERE v.deleted_at IS NULL ${tenant}
        ORDER BY v.mmsi
        LIMIT ${page.limit} OFFSET ${page.offset}`),
      this.db.select({ total: count() }).from(vessels).where(where),
    ]);
    const rows = result.rows.map((row) => ({
      mmsi: row.mmsi,
      vesselId: row.vessel_id,
      orgId: row.org_id,
      name: row.name,
      status: row.status,
      lastReadingAt: asNullableDate(row.last_reading_at),
      devices: row.devices,
    }));
    return { rows, total: totals[0]?.total ?? 0 };
  }
}

const storedColumns = {
  time: fuelReadings.time,
  mmsi: fuelReadings.mmsi,
  deviceId: fuelReadings.deviceId,
  periodStart: fuelReadings.periodStart,
  fuelMeTon: fuelReadings.fuelMeTon,
  fuelAeTon: fuelReadings.fuelAeTon,
  source: fuelReadings.source,
  receivedAt: fuelReadings.receivedAt,
};

function aggregateView(
  bucket: AggregateBucket,
): typeof fuelHourly | typeof fuelDaily {
  return bucket === '1h' ? fuelHourly : fuelDaily;
}

/** One row of totals of a summary piece (aggregates over no rows give count 0). */
function pieceTotalsQuery(mmsi: number, piece: SummaryPiece): SQL {
  if (piece.source === 'raw') {
    return sql`(SELECT count(*)::integer AS readings,
        sum(${fuelReadings.fuelMeTon}) AS fuel_me_ton,
        sum(${fuelReadings.fuelAeTon}) AS fuel_ae_ton,
        min(${fuelReadings.time}) AS first_time,
        max(${fuelReadings.time}) AS last_time
      FROM ${fuelReadings}
      WHERE ${fuelReadings.mmsi} = ${mmsi}
        AND ${fuelReadings.time} >= ${piece.from} AND ${fuelReadings.time} < ${piece.to})`;
  }
  const view = aggregateView(piece.source);
  return sql`(SELECT coalesce(sum(${view.readings}), 0)::integer AS readings,
      sum(${view.fuelMeTon}) AS fuel_me_ton,
      sum(${view.fuelAeTon}) AS fuel_ae_ton,
      min(${view.firstTime}) AS first_time,
      max(${view.lastTime}) AS last_time
    FROM ${view}
    WHERE ${view.mmsi} = ${mmsi}
      AND ${view.bucket} >= ${piece.from} AND ${view.bucket} < ${piece.to})`;
}

/** The stored readings of the given keys. */
async function selectByKeys(
  executor: Executor,
  keys: readonly ReadingKeyed[],
): Promise<StoredReading[]> {
  const { mmsis, times, from, to } = keyArrays(keys);
  const result = await executor.execute<{
    time: Date | string;
    mmsi: number;
    device_id: string | null;
    period_start: Date | string | null;
    fuel_me_ton: number;
    fuel_ae_ton: number;
    source: FuelReadingSource;
    received_at: Date | string;
  }>(sql`
    SELECT r.time, r.mmsi, r.device_id, r.period_start, r.fuel_me_ton, r.fuel_ae_ton,
           r.source, r.received_at
    FROM ${fuelReadings} r
    JOIN unnest(${sql.param(mmsis)}::integer[], ${sql.param(times)}::timestamptz[]) AS k(mmsi, time)
      ON r.mmsi = k.mmsi AND r.time = k.time
    WHERE r.time >= ${from} AND r.time <= ${to}`);
  return result.rows.map((row) => ({
    time: asDate(row.time),
    mmsi: row.mmsi,
    deviceId: row.device_id,
    periodStart: asNullableDate(row.period_start),
    fuelMeTon: row.fuel_me_ton,
    fuelAeTon: row.fuel_ae_ton,
    source: row.source,
    receivedAt: asDate(row.received_at),
  }));
}

/** Sets `published_at` of the readings and removes them from the queue. */
async function markPublishedWith(
  executor: Executor,
  keys: readonly ReadingKeyed[],
): Promise<void> {
  if (keys.length === 0) return;
  const { mmsis, times, from, to } = keyArrays(keys);
  const keyTable = sql`unnest(${sql.param(mmsis)}::integer[], ${sql.param(times)}::timestamptz[]) AS k(mmsi, time)`;
  await executor.execute(sql`
    UPDATE ${fuelReadings} r SET published_at = now()
    FROM ${keyTable}
    WHERE r.mmsi = k.mmsi AND r.time = k.time
      AND r.time >= ${from} AND r.time <= ${to}
      AND r.published_at IS NULL`);
  await executor.execute(sql`
    DELETE FROM ${fuelReadingsUnpublished} u
    USING ${keyTable}
    WHERE u.mmsi = k.mmsi AND u.time = k.time`);
}

/** Parallel arrays of keys (ISO strings for exact timestamps) and their time bounds. */
function keyArrays(keys: readonly ReadingKeyed[]): {
  mmsis: number[];
  times: string[];
  from: Date;
  to: Date;
} {
  const millis = keys.map((key) => key.time.getTime());
  return {
    mmsis: keys.map((key) => key.mmsi),
    times: keys.map((key) => key.time.toISOString()),
    from: new Date(Math.min(...millis)),
    to: new Date(Math.max(...millis)),
  };
}

function keyOf(key: ReadingKeyed): string {
  return `${key.mmsi}:${key.time.getTime()}`;
}

/** A timestamptz of a raw statement (drizzle's driver setup returns them as text). */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : asDate(value);
}
