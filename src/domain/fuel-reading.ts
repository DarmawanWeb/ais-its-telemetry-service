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
  | 'period_too_long';

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
 * Not in the methodology catalog yet (proposed id `telemetry.reading_validation`);
 * the maxima are v2 design defaults, not values from a cited source.
 *
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

/** {@link readingViolations} of every reading of a batch, in batch order. */
export function batchViolations(
  readings: readonly FuelReadingInput[],
  limits: ReadingLimits,
  now: Date,
): ReadingViolation[] {
  return readings.flatMap((reading, index) =>
    readingViolations(reading, index, limits, now),
  );
}

/** Natural key of a reading, `<mmsi>:<time ISO-8601>` (also its `Nats-Msg-Id`). */
export function readingKey(reading: {
  readonly mmsi: number;
  readonly time: Date;
}): string {
  return `${reading.mmsi}:${reading.time.toISOString()}`;
}

/** A batch without repeated `(mmsi, time)` keys and how many were dropped. */
export interface DedupedReadings<T> {
  readonly unique: T[];
  readonly duplicates: number;
}

/**
 * Drops readings whose `(mmsi, time)` already occurred earlier in the batch
 * (the first one wins, as it does against stored readings), keeping order.
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
