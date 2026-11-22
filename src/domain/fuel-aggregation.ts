/** Resolution of a fuel series: raw readings, hourly or daily sums (UTC). */
export const FUEL_BUCKETS = ['raw', '1h', '1d'] as const;

/** A {@link FUEL_BUCKETS} member. */
export type FuelBucket = (typeof FUEL_BUCKETS)[number];

/** An aggregated resolution (a continuous aggregate of migration 0002). */
export type AggregateBucket = Exclude<FuelBucket, 'raw'>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Width of an aggregated bucket, ms (`time_bucket` widths of `fuel_hourly` / `fuel_daily`). */
export const BUCKET_WIDTH_MS: Readonly<Record<AggregateBucket, number>> = {
  '1h': HOUR_MS,
  '1d': DAY_MS,
};

/** Default (missing `from`) and longest time range of a series query per resolution. */
export const SERIES_RANGES: Readonly<
  Record<FuelBucket, { readonly defaultMs: number; readonly maxMs: number }>
> = {
  raw: { defaultMs: DAY_MS, maxMs: 31 * DAY_MS },
  '1h': { defaultMs: 7 * DAY_MS, maxMs: 366 * DAY_MS },
  '1d': { defaultMs: 365 * DAY_MS, maxMs: 5 * 366 * DAY_MS },
};

/** Default and longest range of a summary query (the readings' 5-year retention). */
export const SUMMARY_RANGE = {
  defaultMs: 30 * DAY_MS,
  maxMs: 5 * 366 * DAY_MS,
} as const;

/** Start of the UTC bucket containing `date` (TimescaleDB `time_bucket` alignment). */
export function floorToBucket(date: Date, bucket: AggregateBucket): Date {
  const width = BUCKET_WIDTH_MS[bucket];
  return new Date(Math.floor(date.getTime() / width) * width);
}

/** `date` when it starts a UTC bucket, else the start of the next bucket. */
export function ceilToBucket(date: Date, bucket: AggregateBucket): Date {
  const width = BUCKET_WIDTH_MS[bucket];
  return new Date(Math.ceil(date.getTime() / width) * width);
}

/** A half-open range `[from, to)` read from one source of a summary. */
export interface SummaryPiece {
  /** `raw` = `fuel_readings`, `1h` = `fuel_hourly`, `1d` = `fuel_daily`. */
  readonly source: FuelBucket;
  readonly from: Date;
  readonly to: Date;
}

/**
 * Splits `[from, to)` into the fewest pieces that each source can answer
 * exactly: whole UTC days from `fuel_daily`, whole hours around them from
 * `fuel_hourly` and the unaligned edges from the raw readings. The pieces
 * are contiguous, ordered and cover the range exactly once, so the sum of
 * their totals equals the sum over the raw readings.
 *
 * @example
 * planSummaryPieces(10:30 day 1, 02:15 day 3)
 * // raw [10:30, 11:00) · 1h [11:00, 00:00) · 1d [day 2, day 3) · 1h [00:00, 02:00) · raw [02:00, 02:15)
 */
export function planSummaryPieces(from: Date, to: Date): SummaryPiece[] {
  if (from.getTime() >= to.getTime()) return [];
  const hourStart = ceilToBucket(from, '1h');
  const hourEnd = floorToBucket(to, '1h');
  if (hourStart.getTime() >= hourEnd.getTime()) {
    return [{ source: 'raw', from, to }];
  }

  const pieces: SummaryPiece[] = [];
  const push = (source: FuelBucket, start: Date, end: Date): void => {
    if (start.getTime() < end.getTime())
      pieces.push({ source, from: start, to: end });
  };
  const dayStart = ceilToBucket(hourStart, '1d');
  const dayEnd = floorToBucket(hourEnd, '1d');

  push('raw', from, hourStart);
  if (dayStart.getTime() < dayEnd.getTime()) {
    push('1h', hourStart, dayStart);
    push('1d', dayStart, dayEnd);
    push('1h', dayEnd, hourEnd);
  } else {
    push('1h', hourStart, hourEnd);
  }
  push('raw', hourEnd, to);
  return pieces;
}

/** Sums of the readings in a time range. */
export interface FuelTotals {
  readonly readings: number;
  /** Main-engine fuel, t. */
  readonly fuelMeTon: number;
  /** Auxiliary-engine fuel, t. */
  readonly fuelAeTon: number;
  readonly firstReadingAt: Date | null;
  readonly lastReadingAt: Date | null;
}

/** Totals of an empty range. */
export const EMPTY_TOTALS: FuelTotals = Object.freeze({
  readings: 0,
  fuelMeTon: 0,
  fuelAeTon: 0,
  firstReadingAt: null,
  lastReadingAt: null,
});

/**
 * Fuel of a time window as the sum of the readings in it, per engine group:
 * `FC_x = Σ_{r ∈ window} r.fuel_x` (t, x ∈ {ME, AE}); a reading belongs to
 * the window of its `time`. Combines the totals of two disjoint windows.
 *
 * @method telemetry.fuel_reading_usage
 * @see ../../../../docs/METHODOLOGY.md#telemetry.fuel_reading_usage
 * @see legacy-mvp-backend — be-legacy/src/services/cii/cii.service.ts (`calculateCII`: telemetry fuel ME + AE)
 */
export function addTotals(a: FuelTotals, b: FuelTotals): FuelTotals {
  return {
    readings: a.readings + b.readings,
    fuelMeTon: roundFuelSum(a.fuelMeTon + b.fuelMeTon),
    fuelAeTon: roundFuelSum(a.fuelAeTon + b.fuelAeTon),
    firstReadingAt: earliest(a.firstReadingAt, b.firstReadingAt),
    lastReadingAt: latest(a.lastReadingAt, b.lastReadingAt),
  };
}

/**
 * Total fuel of both engine groups, `FC = FC_ME + FC_AE` (t); the legacy
 * `totalFuelConsumptionTon`.
 *
 * @method telemetry.fuel_reading_usage
 * @see ../../../../docs/METHODOLOGY.md#telemetry.fuel_reading_usage
 */
export function totalFuelTon(fuelMeTon: number, fuelAeTon: number): number {
  return roundFuelSum(fuelMeTon + fuelAeTon);
}

/** Computed fuel sums are reported to this many decimals of a tonne (1 mg, far below any meter's resolution). */
export const FUEL_SUM_DECIMALS = 9;

const FUEL_SUM_SCALE = 10 ** FUEL_SUM_DECIMALS;

/**
 * Rounds a computed sum of fuel amounts (t) to {@link FUEL_SUM_DECIMALS}
 * decimals, so that binary floating-point artifacts of the addition
 * (`0.1 + 0.2` = `0.30000000000000004`) do not reach clients; the readings
 * themselves are returned as stored. Values too large to scale exactly
 * (> ~9·10⁶ t) and non-finite values are returned unchanged.
 */
export function roundFuelSum(value: number): number {
  const scaled = value * FUEL_SUM_SCALE;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
    return value;
  // Dividing the integer by the exact scale gives the double nearest to the decimal.
  return Math.round(scaled) / FUEL_SUM_SCALE;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
