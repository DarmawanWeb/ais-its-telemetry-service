import { describe, expect, it } from 'vitest';

import {
  batchViolations,
  dedupeReadings,
  type FuelReadingInput,
  readingKey,
  type ReadingLimits,
  readingViolations,
} from './fuel-reading.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');

const LIMITS: ReadingLimits = {
  maxFuelMeTon: 500,
  maxFuelAeTon: 100,
  maxFutureSkewMs: 5 * 60_000,
  maxAgeMs: 1825 * 86_400_000,
  maxPeriodMs: 24 * 3_600_000,
};

function reading(overrides: Partial<FuelReadingInput> = {}): FuelReadingInput {
  return {
    mmsi: 525005223,
    time: new Date('2026-11-21T09:00:00.000Z'),
    periodStart: null,
    fuelMeTon: 0.42,
    fuelAeTon: 0.05,
    ...overrides,
  };
}

const codesOf = (input: FuelReadingInput) =>
  readingViolations(input, 0, LIMITS, NOW).map((v) => `${v.field}:${v.code}`);

describe('readingViolations', () => {
  it('accepts a plausible reading, zero fuel and the exact maxima', () => {
    expect(codesOf(reading())).toEqual([]);
    expect(codesOf(reading({ fuelMeTon: 0, fuelAeTon: 0 }))).toEqual([]);
    expect(codesOf(reading({ fuelMeTon: 500, fuelAeTon: 100 }))).toEqual([]);
  });

  it('rejects negative, non-finite and excessive fuel per engine group', () => {
    expect(codesOf(reading({ fuelMeTon: -0.001 }))).toEqual([
      'fuelMeTon:negative',
    ]);
    expect(codesOf(reading({ fuelAeTon: Number.NaN }))).toEqual([
      'fuelAeTon:not_finite',
    ]);
    expect(codesOf(reading({ fuelMeTon: Number.POSITIVE_INFINITY }))).toEqual([
      'fuelMeTon:not_finite',
    ]);
    expect(codesOf(reading({ fuelMeTon: 500.01, fuelAeTon: 100.5 }))).toEqual([
      'fuelMeTon:above_maximum',
      'fuelAeTon:above_maximum',
    ]);
  });

  it('allows a clock skew of at most 5 minutes into the future', () => {
    const at = (ms: number) => reading({ time: new Date(NOW.getTime() + ms) });
    expect(codesOf(at(5 * 60_000))).toEqual([]);
    expect(codesOf(at(5 * 60_000 + 1))).toEqual(['time:future_time']);
    expect(readingViolations(at(6 * 60_000), 0, LIMITS, NOW)[0]?.message).toBe(
      'time must not be more than 5 min ahead of the server clock',
    );
  });

  it('refuses readings older than the retention period', () => {
    const ago = (ms: number) => reading({ time: new Date(NOW.getTime() - ms) });
    expect(codesOf(ago(1825 * 86_400_000))).toEqual([]);
    expect(codesOf(ago(1825 * 86_400_000 + 1))).toEqual(['time:too_old']);
    expect(
      readingViolations(ago(1826 * 86_400_000), 0, LIMITS, NOW)[0]?.message,
    ).toBe('time must not be more than 1825 d in the past (retention period)');
  });

  it('requires periodStart before time and a period of at most 24 h', () => {
    const time = new Date('2026-11-21T09:00:00.000Z');
    const startingAt = (ms: number) =>
      reading({ time, periodStart: new Date(time.getTime() - ms) });
    expect(codesOf(startingAt(3_600_000))).toEqual([]);
    expect(codesOf(startingAt(24 * 3_600_000))).toEqual([]);
    expect(codesOf(startingAt(0))).toEqual([
      'periodStart:period_not_before_time',
    ]);
    expect(codesOf(startingAt(-1))).toEqual([
      'periodStart:period_not_before_time',
    ]);
    expect(codesOf(startingAt(24 * 3_600_000 + 1))).toEqual([
      'periodStart:period_too_long',
    ]);
  });
});

describe('batchViolations', () => {
  it('reports every violation with the index of its reading', () => {
    const violations = batchViolations(
      [
        reading(),
        reading({ fuelMeTon: -1 }),
        reading({ fuelAeTon: 101, time: new Date('2026-11-22T00:00:00Z') }),
      ],
      LIMITS,
      NOW,
    );
    expect(violations.map((v) => `${v.index}.${v.field}`)).toEqual([
      '1.fuelMeTon',
      '2.fuelAeTon',
      '2.time',
    ]);
  });
});

describe('readingKey', () => {
  it('is <mmsi>:<ISO time> (the Nats-Msg-Id of the event)', () => {
    expect(readingKey(reading())).toBe('525005223:2026-11-21T09:00:00.000Z');
  });
});

describe('dedupeReadings', () => {
  it('keeps the first reading of each (mmsi, time) in order', () => {
    const first = reading({ fuelMeTon: 1 });
    const repeated = reading({ fuelMeTon: 2 });
    const otherVessel = reading({ mmsi: 525005224 });
    const later = reading({ time: new Date('2026-11-21T09:01:00Z') });

    const result = dedupeReadings([first, repeated, otherVessel, later, first]);

    expect(result.unique).toEqual([first, otherVessel, later]);
    expect(result.duplicates).toBe(2);
  });
});
