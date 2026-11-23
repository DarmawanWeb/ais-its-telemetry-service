import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';

/** Where a reading came from (`source` of `fuel.reading.recorded.v1`). */
export type FuelReadingSource = FuelReadingRecordedV1['source'];

/**
 * Every reading source:
 * - `device`: a registered `http` device posting with its own API key;
 * - `mqtt`: a registered `mqtt` device through the NATS MQTT gateway;
 * - `api`: an API key not linked to a device (partner systems, gateways);
 * - `manual`: a signed-in user (`telemetry:write`);
 * - `import`: a signed-in user loading historical data (`?source=import`).
 */
export const FUEL_READING_SOURCES = [
  'device',
  'mqtt',
  'api',
  'manual',
  'import',
] as const satisfies readonly FuelReadingSource[];

/** Sources a signed-in user may choose for the readings they post. */
export const USER_READING_SOURCES = [
  'manual',
  'import',
] as const satisfies readonly FuelReadingSource[];

/** A source a signed-in user may choose. */
export type UserReadingSource = (typeof USER_READING_SOURCES)[number];

/** Most readings in one request or one device message (spec §13.4). */
export const MAX_READINGS_PER_BATCH = 1000;

/**
 * A fuel consumption reading as reported: tonnes of fuel burnt by the main
 * (ME) and auxiliary (AE) engines in the period ending at `time` (since
 * `periodStart` when given, else since the previous reading of the vessel).
 * Types are validated; the plausibility rules are {@link readingViolations}.
 */
export interface FuelReadingInput {
  readonly mmsi: number;
  readonly time: Date;
  readonly periodStart: Date | null;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
}

/** Thresholds of the plausibility rules (configurable, see `config.ts`). */
export interface ReadingLimits {
  /** Largest main-engine fuel of one reading, t. */
  readonly maxFuelMeTon: number;
  /** Largest auxiliary-engine fuel of one reading, t. */
  readonly maxFuelAeTon: number;
  /** How far `time` may lie ahead of the server clock (device clock skew), ms. */
  readonly maxFutureSkewMs: number;
  /**
   * How far `time` may lie behind the server clock, ms: at most the 5-year
   * retention of `fuel_readings`, whose policy would drop older readings.
   */
  readonly maxAgeMs: number;
  /** Longest measured period `time − periodStart`, ms. */
  readonly maxPeriodMs: number;
}

/** Machine-readable reason of a {@link ReadingViolation}. */
export type ReadingViolationCode =
  | 'negative'
  | 'not_finite'
  | 'above_maximum'
  | 'future_time'
  | 'too_old'
  | 'period_not_before_time'
  | 'period_too_long'
  | 'conflicting_repeat';

/** A broken plausibility rule of the reading at `index` of a batch. */
export interface ReadingViolation {
  readonly index: number;
  readonly field: 'time' | 'periodStart' | 'fuelMeTon' | 'fuelAeTon';
  readonly code: ReadingViolationCode;
  readonly message: string;
}

/**
 * Plausibility rules of one reading (spec §13.4): fuel amounts are finite,
 * non-negative and at most the configured maxima (t); `time` is at most
 * `maxFutureSkewMs` ahead of `now` and at most `maxAgeMs` behind it (the
 * retention period); a `periodStart` lies before `time` and the period
 * lasts at most `maxPeriodMs`. Pure: the caller passes the clock.
 *
 * The 5-minute skew comes from spec §13.4; the fuel maxima, the 24-h period
 * and the 5-year age are v2 design defaults, not values from a cited source.
 *
 * @method telemetry.reading_validation
 * @returns every violation (empty when the reading is plausible).
 */
export function readingViolations(
  reading: FuelReadingInput,
  index: number,
  limits: ReadingLimits,
  now: Date,
): ReadingViolation[] {
  const violations: ReadingViolation[] = [];
  const fuel = [
    ['fuelMeTon', reading.fuelMeTon, limits.maxFuelMeTon],
    ['fuelAeTon', reading.fuelAeTon, limits.maxFuelAeTon],
  ] as const;
  for (const [field, value, maximum] of fuel) {
    if (!Number.isFinite(value)) {
      violations.push({
        index,
        field,
        code: 'not_finite',
        message: `${field} must be a finite number`,
      });
    } else if (value < 0) {
      violations.push({
        index,
        field,
        code: 'negative',
        message: `${field} must not be negative`,
      });
    } else if (value > maximum) {
      violations.push({
        index,
        field,
        code: 'above_maximum',
        message: `${field} must not exceed ${maximum} t`,
      });
    }
  }

  const aheadMs = reading.time.getTime() - now.getTime();
  if (aheadMs > limits.maxFutureSkewMs) {
    violations.push({
      index,
      field: 'time',
      code: 'future_time',
      message: `time must not be more than ${formatMinutes(limits.maxFutureSkewMs)} ahead of the server clock`,
    });
  } else if (-aheadMs > limits.maxAgeMs) {
    violations.push({
      index,
      field: 'time',
      code: 'too_old',
      message: `time must not be more than ${formatMinutes(limits.maxAgeMs)} in the past (retention period)`,
    });
  }

  if (reading.periodStart !== null) {
    const periodMs = reading.time.getTime() - reading.periodStart.getTime();
    if (periodMs <= 0) {
      violations.push({
        index,
        field: 'periodStart',
        code: 'period_not_before_time',
        message: 'periodStart must be before time',
      });
    } else if (periodMs > limits.maxPeriodMs) {
      violations.push({
        index,
        field: 'periodStart',
        code: 'period_too_long',
        message: `the measured period must not exceed ${formatMinutes(limits.maxPeriodMs)}`,
      });
    }
  }
  return violations;
}

/**
 * {@link readingViolations} of every reading of a batch plus
 * {@link repeatViolations}, ordered by batch index (the batch limit of 1000
 * readings, spec §13.4, is checked by the request parsers).
 *
 * @method telemetry.reading_validation
 */
export function batchViolations(
  readings: readonly FuelReadingInput[],
  limits: ReadingLimits,
  now: Date,
): ReadingViolation[] {
  return [
    ...readings.flatMap((reading, index) =>
      readingViolations(reading, index, limits, now),
    ),
    ...repeatViolations(readings),
  ].sort((a, b) => a.index - b.index);
}

/**
 * A vessel has one reading per `time` (the key of `fuel_readings`), so a
 * batch must not report two different readings for the same `(mmsi, time)`:
 * keeping either would silently drop the other. Exact repeats are fine
 * (they are idempotent duplicates, see {@link dedupeReadings}).
 *
 * Part of the plausibility rules (see {@link readingViolations}); a v2
 * data-integrity rule without an external source.
 *
 * @method telemetry.reading_validation
 * @returns a `conflicting_repeat` violation on `time` for every reading that
 * repeats the key of an earlier reading of the batch with other values.
 */
export function repeatViolations(
  readings: readonly FuelReadingInput[],
): ReadingViolation[] {
  const first = new Map<
    string,
    { readonly index: number; readonly reading: FuelReadingInput }
  >();
  const violations: ReadingViolation[] = [];
  readings.forEach((reading, index) => {
    const key = readingKey(reading);
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, { index, reading });
    } else if (!sameMeasurement(reading, earlier.reading)) {
      violations.push({
        index,
        field: 'time',
        code: 'conflicting_repeat',
        message: `repeats MMSI ${reading.mmsi} and time ${reading.time.toISOString()} of reading ${earlier.index} with different values`,
      });
    }
  });
  return violations;
}

/** Natural key of a reading, `<mmsi>:<time ISO-8601>` (also its `Nats-Msg-Id`). */
export function readingKey(reading: {
  readonly mmsi: number;
  readonly time: Date;
}): string {
  return `${reading.mmsi}:${reading.time.toISOString()}`;
}

/** What two readings of the same `(mmsi, time)` must share to be the same measurement. */
export type MeasuredValues = Pick<
  FuelReadingInput,
  'periodStart' | 'fuelMeTon' | 'fuelAeTon'
>;

/** Whether two readings report the same period and the same amounts (exactly). */
export function sameMeasurement(a: MeasuredValues, b: MeasuredValues): boolean {
  return (
    a.fuelMeTon === b.fuelMeTon &&
    a.fuelAeTon === b.fuelAeTon &&
    (a.periodStart?.getTime() ?? null) === (b.periodStart?.getTime() ?? null)
  );
}

/** A reading with its device, as compared against a stored one. */
export interface AttributedReading extends FuelReadingInput {
  readonly deviceId: string | null;
}

/** Readings of a batch sorted by what is stored under their key already. */
export interface StoredComparison<T> {
  /** No stored reading has the key. */
  readonly fresh: T[];
  /** The stored reading is the same measurement of the same device: an idempotent retry. */
  readonly duplicates: T[];
  /** The stored reading differs (amounts, period or device): not stored, never overwritten. */
  readonly conflicts: T[];
}

/**
 * Compares readings with the stored readings of the same keys. A repeat is a
 * duplicate only when it is the same measurement ({@link sameMeasurement})
 * **of the same device** (`null` = no device): two meters of one vessel that
 * report the same instant are a conflict even with equal amounts, because
 * the stored row can hold only one of them. The source label is not compared
 * (a user re-posting a manual entry as an import repeats the same data).
 * A v2 data-integrity rule (spec §13.4: duplicates idempotent by `(mmsi, time)`).
 *
 * @method telemetry.reading_validation
 */
export function compareWithStored<T extends AttributedReading>(
  readings: readonly T[],
  stored: readonly AttributedReading[],
): StoredComparison<T> {
  const byKey = new Map(stored.map((row) => [readingKey(row), row]));
  const result: StoredComparison<T> = {
    fresh: [],
    duplicates: [],
    conflicts: [],
  };
  for (const reading of readings) {
    const row = byKey.get(readingKey(reading));
    if (row === undefined) result.fresh.push(reading);
    else if (row.deviceId === reading.deviceId && sameMeasurement(reading, row))
      result.duplicates.push(reading);
    else result.conflicts.push(reading);
  }
  return result;
}

/** Length of a storage window, ms: one UTC day. */
export const STORAGE_WINDOW_MS = 86_400_000;

/**
 * Splits items into UTC days of their `time`, in chronological order (input
 * order within a day). Each window is stored in its own transaction:
 * TimescaleDB logs one invalidation range `[min, max]` per transaction and
 * chunk, and the next refresh of `fuel_hourly` / `fuel_daily` re-aggregates
 * that whole range for every vessel. Per-day transactions bound this to the
 * days that hold readings instead of everything between the oldest and the
 * newest reading of a request. Bulk statements on stored keys use the same
 * windows to keep their time bounds tight (chunk and batch pruning).
 */
export function groupByStorageWindow<T extends { readonly time: Date }>(
  items: readonly T[],
): T[][] {
  const windows = new Map<number, T[]>();
  for (const item of items) {
    const day = Math.floor(item.time.getTime() / STORAGE_WINDOW_MS);
    const window = windows.get(day);
    if (window === undefined) windows.set(day, [item]);
    else window.push(item);
  }
  return [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, window]) => window);
}

/** A batch without repeated `(mmsi, time)` keys and how many were dropped. */
export interface DedupedReadings<T> {
  readonly unique: T[];
  readonly duplicates: number;
}

/**
 * Drops readings whose `(mmsi, time)` already occurred earlier in the batch,
 * keeping order. Validated batches repeat a key only with the same values
 * ({@link repeatViolations}), so nothing but exact repeats is dropped.
 */
export function dedupeReadings<T extends FuelReadingInput>(
  readings: readonly T[],
): DedupedReadings<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const reading of readings) {
    const key = readingKey(reading);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reading);
  }
  return { unique, duplicates: readings.length - unique.length };
}

/** `5 min`, `24 h`, `1825 d`, `90 s` for messages. */
function formatMinutes(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}
