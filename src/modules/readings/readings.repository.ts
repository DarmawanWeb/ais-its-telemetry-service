import {
  type Database,
  InjectDb,
  rowDate,
  rowDateOrNull,
} from '@darmawanweb/ais-its-nest/db';
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
  type SQLWrapper,
} from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import {
  type AggregateBucket,
  EMPTY_TOTALS,
  type FuelBucket,
  type FuelTotals,
  roundFuelSum,
  type SummaryPiece,
} from '../../domain/fuel-aggregation.js';
import {
  compareWithStored,
  type FuelReadingSource,
  groupByStorageWindow,
} from '../../domain/fuel-reading.js';
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

/** Time order of a fuel series: oldest first (`asc`) or newest first (`desc`). */
export const SERIES_ORDERS = ['asc', 'desc'] as const;

/** A {@link SERIES_ORDERS} member. */
export type SeriesOrder = (typeof SERIES_ORDERS)[number];

/** A query of a fuel series page: `limit` points of `[from, to)` after `after` in `order`. */
export interface SeriesQuery {
  readonly mmsi: number;
  readonly bucket: FuelBucket;
  readonly from: Date;
  readonly to: Date;
  readonly order: SeriesOrder;
  /**
   * Exclusive position of the previous page (cursor): the page holds the
   * points after it in `order`, i.e. later for `asc`, earlier for `desc`.
   */
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

/** What {@link ReadingsRepository.store} did with the readings of one window. */
export interface StoreResult {
  /** Readings stored (and queued for publication) by this call. */
  readonly stored: StoredReading[];
  /** Readings whose key holds the same measurement of the same device already (idempotent). */
  readonly duplicates: NewReading[];
  /** Readings whose key holds a different reading already; never stored, never overwriting. */
  readonly conflicts: NewReading[];
  /**
   * `true` when conflicts aborted the transaction (`rejectConflicts`):
   * nothing of the window was stored, `stored` is empty.
   */
  readonly rejected: boolean;
}

/** The key of a stored reading. */
type ReadingKeyed = Pick<StoredReading, 'mmsi' | 'time'>;

/** Aborts a store transaction on conflicts while carrying its result out. */
class ConflictRollback extends Error {
  override readonly name = 'ConflictRollback';

  constructor(readonly result: StoreResult) {
    super('readings conflict with stored readings');
  }
}

/** A database handle or an open transaction. */
type Executor = Pick<
  Database<typeof schema>,
  'execute' | 'insert' | 'select' | 'delete'
>;

/**
 * Access to `fuel_readings`, its publication queue and the continuous
 * aggregates. Bulk statements on stored keys bind arrays (`unnest`) so that
 * 1 000 keys cost a constant number of parameters, and run per storage
 * window with constant MMSI and time bounds so that TimescaleDB prunes
 * chunks and compressed batches.
 */
@Injectable()
export class ReadingsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Stores the readings of one storage window (one UTC day, see
   * `groupByStorageWindow`) and queues them for publication, in one
   * transaction. A reading whose `(mmsi, time)` exists already is not
   * written: it is a duplicate when the stored reading is the same
   * measurement of the same device, else a conflict (`compareWithStored`).
   * With `rejectConflicts` any conflict rolls the whole window back.
   *
   * Concurrent writers of a key serialize on the primary key: the second
   * `INSERT … ON CONFLICT DO NOTHING` waits for the first transaction and
   * then compares against its committed row (READ COMMITTED snapshot of the
   * next statement).
   */
  async store(
    readings: readonly NewReading[],
    options: { readonly rejectConflicts: boolean },
  ): Promise<StoreResult> {
    if (readings.length === 0) {
      return { stored: [], duplicates: [], conflicts: [], rejected: false };
    }
    try {
      return await this.db.transaction(async (tx) => {
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
          .onConflictDoNothing({
            target: [fuelReadings.mmsi, fuelReadings.time],
          })
          .returning(storedColumns);
        const storedKeys = new Set(stored.map(keyOf));
        const skipped = readings.filter(
          (reading) => !storedKeys.has(keyOf(reading)),
        );
        const existing =
          skipped.length === 0 ? [] : await selectByKeys(tx, skipped);
        const { fresh, duplicates, conflicts } = compareWithStored(
          skipped,
          existing,
        );
        // `fresh` here: the row that blocked the insert is gone already
        // (retention dropped its chunk); nothing is left to conflict with.
        const result: StoreResult = {
          stored,
          duplicates: [...duplicates, ...fresh],
          conflicts,
          rejected: false,
        };
        if (conflicts.length > 0 && options.rejectConflicts) {
          throw new ConflictRollback({ ...result, stored: [], rejected: true });
        }
        if (stored.length > 0) {
          await tx.insert(fuelReadingsUnpublished).values(
            stored.map((reading) => ({
              mmsi: reading.mmsi,
              time: reading.time,
              receivedAt: reading.receivedAt,
            })),
          );
        }
        return result;
      });
    } catch (error) {
      if (error instanceof ConflictRollback) return error.result;
      throw error;
    }
  }

  /** The stored readings with the given keys (read only; missing keys are absent). */
  async findStored(keys: readonly ReadingKeyed[]): Promise<StoredReading[]> {
    if (keys.length === 0) return [];
    return selectByKeys(this.db, keys);
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

  /**
   * One page of a fuel series in `query.order` (fetch `limit + 1` to detect
   * more). Readings and buckets are unique per vessel and time, so the time
   * alone positions a page.
   */
  async series(query: SeriesQuery): Promise<SeriesPoint[]> {
    const ascending = query.order === 'asc';
    if (query.bucket === 'raw') {
      const rows = await this.db
        .select(storedColumns)
        .from(fuelReadings)
        .where(
          and(
            eq(fuelReadings.mmsi, query.mmsi),
            gte(fuelReadings.time, query.from),
            lt(fuelReadings.time, query.to),
            beyond(fuelReadings.time, query.after, ascending),
          ),
        )
        .orderBy(ascending ? asc(fuelReadings.time) : desc(fuelReadings.time))
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
          beyond(view.bucket, query.after, ascending),
        ),
      )
      .orderBy(ascending ? asc(view.bucket) : desc(view.bucket))
      .limit(query.limit);
    return rows.map((row) => ({
      time: row.bucket,
      fuelMeTon: roundFuelSum(row.fuelMeTon),
      fuelAeTon: roundFuelSum(row.fuelAeTon),
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
            fuelMeTon: roundFuelSum(row.fuel_me_ton ?? 0),
            fuelAeTon: roundFuelSum(row.fuel_ae_ton ?? 0),
            firstReadingAt: rowDateOrNull(row.first_time),
            lastReadingAt: rowDateOrNull(row.last_time),
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
      lastReadingAt: rowDateOrNull(row.last_reading_at),
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

/** The keyset condition of a page: after `position` in the page order (none on the first page). */
function beyond(
  column: SQLWrapper,
  position: Date | undefined,
  ascending: boolean,
): SQL | undefined {
  if (position === undefined) return undefined;
  return ascending ? gt(column, position) : lt(column, position);
}

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

/**
 * The stored readings of the given keys: one statement per storage window
 * (UTC day), each bounded by the window's MMSIs and time range.
 */
async function selectByKeys(
  executor: Executor,
  keys: readonly ReadingKeyed[],
): Promise<StoredReading[]> {
  const rows: StoredReading[] = [];
  for (const window of groupByStorageWindow(keys)) {
    const { mmsis, vessels, times, from, to } = keyArrays(window);
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
      WHERE r.mmsi = ANY(${sql.param(vessels)}::integer[])
        AND r.time >= ${from} AND r.time <= ${to}`);
    for (const row of result.rows) {
      rows.push({
        time: rowDate(row.time),
        mmsi: row.mmsi,
        deviceId: row.device_id,
        periodStart: rowDateOrNull(row.period_start),
        fuelMeTon: row.fuel_me_ton,
        fuelAeTon: row.fuel_ae_ton,
        source: row.source,
        receivedAt: rowDate(row.received_at),
      });
    }
  }
  return rows;
}

/**
 * Sets `published_at` of the readings and removes them from the queue.
 * Runs inside the caller's transaction.
 *
 * `published_at` feeds no continuous aggregate, so the update is excluded
 * from invalidation logging (`SET LOCAL timescaledb.skip_cagg_invalidation`,
 * TimescaleDB ≥ 2.22, a user-settable parameter): otherwise every late
 * reading would be invalidated twice, the second time over the whole range
 * of the request or relay batch, and the next refresh would re-aggregate
 * that range for every vessel although no sum changed.
 *
 * Readings of compressed chunks (imports, store-and-forward data older than
 * the 7-day compression delay) are updated by decompressing the batches
 * that may hold them. TimescaleDB selects those batches only by constant
 * conditions on the `segmentby` column (`mmsi`) and the time range — never
 * by the key join — so every statement names its MMSIs with `= ANY(…)` and
 * covers one storage window (UTC day): only the batches of these vessels
 * that overlap the window's key range are decompressed, not those of every
 * vessel in a range spanning the whole key set.
 */
async function markPublishedWith(
  executor: Executor,
  keys: readonly ReadingKeyed[],
): Promise<void> {
  if (keys.length === 0) return;
  await executor.execute(
    sql`SET LOCAL timescaledb.skip_cagg_invalidation = on`,
  );
  for (const window of groupByStorageWindow(keys)) {
    const { mmsis, vessels, times, from, to } = keyArrays(window);
    await executor.execute(sql`
      UPDATE ${fuelReadings} r SET published_at = now()
      FROM unnest(${sql.param(mmsis)}::integer[], ${sql.param(times)}::timestamptz[]) AS k(mmsi, time)
      WHERE r.mmsi = ANY(${sql.param(vessels)}::integer[])
        AND r.mmsi = k.mmsi AND r.time = k.time
        AND r.time >= ${from} AND r.time <= ${to}
        AND r.published_at IS NULL`);
  }
  const { mmsis, times } = keyArrays(keys);
  await executor.execute(sql`
    DELETE FROM ${fuelReadingsUnpublished} u
    USING unnest(${sql.param(mmsis)}::integer[], ${sql.param(times)}::timestamptz[]) AS k(mmsi, time)
    WHERE u.mmsi = k.mmsi AND u.time = k.time`);
}

/**
 * Parallel arrays of keys (ISO strings for exact timestamps), their distinct
 * MMSIs (the scalar `segmentby` predicate) and their time bounds.
 */
function keyArrays(keys: readonly ReadingKeyed[]): {
  mmsis: number[];
  vessels: number[];
  times: string[];
  from: Date;
  to: Date;
} {
  const millis = keys.map((key) => key.time.getTime());
  const mmsis = keys.map((key) => key.mmsi);
  return {
    mmsis,
    vessels: [...new Set(mmsis)],
    times: keys.map((key) => key.time.toISOString()),
    from: new Date(Math.min(...millis)),
    to: new Date(Math.max(...millis)),
  };
}

function keyOf(key: ReadingKeyed): string {
  return `${key.mmsi}:${key.time.getTime()}`;
}
