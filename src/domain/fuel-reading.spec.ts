import { describe, expect, it } from 'vitest';

import {
  type AttributedReading,
  batchViolations,
  compareWithStored,
  dedupeReadings,
  type FuelReadingInput,
  groupByStorageWindow,
  readingKey,
  type ReadingLimits,
  readingViolations,
  repeatViolations,
  sameMeasurement,
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
        reading({ fuelMeTon: -1, time: new Date('2026-11-21T09:10:00Z') }),
        reading({ fuelAeTon: 101, time: new Date('2026-11-22T00:00:00Z') }),
        reading({ fuelMeTon: 7 }),
      ],
      LIMITS,
      NOW,
    );
    expect(violations.map((v) => `${v.index}.${v.field}:${v.code}`)).toEqual([
      '1.fuelMeTon:negative',
      '2.fuelAeTon:above_maximum',
      '2.time:future_time',
      '3.time:conflicting_repeat',
    ]);
  });
});

describe('repeatViolations', () => {
  it('accepts exact repeats and readings of other vessels or times', () => {
    expect(
      repeatViolations([
        reading(),
        reading(),
        reading({ mmsi: 525005224, fuelMeTon: 9 }),
        reading({ time: new Date('2026-11-21T09:01:00Z'), fuelMeTon: 9 }),
      ]),
    ).toEqual([]);
  });

  it('rejects a repeated (mmsi, time) with other amounts or another period', () => {
    const violations = repeatViolations([
      reading(),
      reading({ fuelAeTon: 0.3 }),
      reading({ periodStart: new Date('2026-11-21T08:00:00Z') }),
    ]);
    expect(violations).toEqual([
      {
        index: 1,
        field: 'time',
        code: 'conflicting_repeat',
        message:
          'repeats MMSI 525005223 and time 2026-11-21T09:00:00.000Z of reading 0 with different values',
      },
      expect.objectContaining({ index: 2, code: 'conflicting_repeat' }),
    ]);
  });
});

describe('sameMeasurement', () => {
  it('compares the period and both amounts exactly', () => {
    const period = new Date('2026-11-21T08:00:00Z');
    expect(sameMeasurement(reading(), reading())).toBe(true);
    expect(
      sameMeasurement(
        reading({ periodStart: period }),
        reading({ periodStart: new Date(period.getTime()) }),
      ),
    ).toBe(true);
    expect(sameMeasurement(reading(), reading({ periodStart: period }))).toBe(
      false,
    );
    expect(sameMeasurement(reading(), reading({ fuelMeTon: 0.42001 }))).toBe(
      false,
    );
    expect(sameMeasurement(reading(), reading({ fuelAeTon: 0 }))).toBe(false);
  });
});

describe('compareWithStored', () => {
  const attributed = (
    deviceId: string | null,
    overrides: Partial<FuelReadingInput> = {},
  ): AttributedReading => ({ ...reading(overrides), deviceId });

  it('sorts readings into fresh keys, idempotent repeats and conflicts', () => {
    const stored = [
      attributed('device-a'),
      attributed(null, { time: new Date('2026-11-21T09:10:00Z') }),
    ];
    const same = attributed('device-a');
    const fresh = attributed('device-a', {
      time: new Date('2026-11-21T09:20:00Z'),
    });
    const otherAmount = attributed(null, {
      time: new Date('2026-11-21T09:10:00Z'),
      fuelMeTon: 1,
    });

    expect(compareWithStored([same, fresh, otherAmount], stored)).toEqual({
      fresh: [fresh],
      duplicates: [same],
      conflicts: [otherAmount],
    });
  });

  it('treats the same instant from another device as a conflict, even with equal amounts', () => {
    // Two meters of one vessel (e.g. main and auxiliary engine) reporting aligned
    // interval boundaries: the second must not vanish as a "duplicate".
    const stored = [attributed('me-meter', { fuelMeTon: 1.5, fuelAeTon: 0 })];
    const aeMeter = attributed('ae-meter', { fuelMeTon: 0, fuelAeTon: 0.3 });
    const twin = attributed('twin-meter', { fuelMeTon: 1.5, fuelAeTon: 0 });
    const manual = attributed(null, { fuelMeTon: 1.5, fuelAeTon: 0 });

    expect(
      compareWithStored([aeMeter, twin, manual], stored).conflicts,
    ).toEqual([aeMeter, twin, manual]);
  });
});

describe('groupByStorageWindow', () => {
  it('splits by UTC day in chronological order, keeping the input order within a day', () => {
    const at = (iso: string) => ({ time: new Date(iso) });
    const late = at('2026-11-21T23:59:59.999Z');
    const early = at('2026-11-21T00:00:00.000Z');
    const nextDay = at('2026-11-22T00:00:00.000Z');
    const yearsAgo = at('2021-12-01T12:00:00.000Z');

    expect(groupByStorageWindow([nextDay, late, yearsAgo, early])).toEqual([
      [yearsAgo],
      [late, early],
      [nextDay],
    ]);
    expect(groupByStorageWindow([])).toEqual([]);
  });
});

describe('readingKey', () => {
  it('is <mmsi>:<ISO time> (the Nats-Msg-Id of the event)', () => {
    expect(readingKey(reading())).toBe('525005223:2026-11-21T09:00:00.000Z');
  });
});

describe('dedupeReadings', () => {
  it('keeps the first reading of each (mmsi, time) in order', () => {
    // Validated batches repeat a key only with equal values (repeatViolations).
    const first = reading({ fuelMeTon: 1 });
    const repeated = reading({ fuelMeTon: 2 });
    const otherVessel = reading({ mmsi: 525005224 });
    const later = reading({ time: new Date('2026-11-21T09:01:00Z') });

    const result = dedupeReadings([first, repeated, otherVessel, later, first]);

    expect(result.unique).toEqual([first, otherVessel, later]);
    expect(result.duplicates).toBe(2);
  });
});
