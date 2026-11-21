import { describe, expect, it } from 'vitest';

import { isTelemetryActive } from './telemetry-status.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/**
 * The legacy rule as written in be-legacy/src/repositories/ships/fuel-data.repository.ts
 * (`isActive`): `(now − createdAt) / 10000 <= 1`, i.e. a 10-second window
 * although the variable is called `differenceInMinutes`.
 */
function legacyIsActive(lastCreatedAt: Date, now: Date): boolean {
  const differenceInMinutes = (now.getTime() - lastCreatedAt.getTime()) / 10000;
  return differenceInMinutes <= 1;
}

describe('isTelemetryActive (fuel.method_selection)', () => {
  it('is active while the newest reading is at most W minutes old', () => {
    expect(isTelemetryActive(ago(0), NOW, 10)).toBe(true);
    expect(isTelemetryActive(ago(10 * 60_000), NOW, 10)).toBe(true);
    expect(isTelemetryActive(ago(10 * 60_000 + 1), NOW, 10)).toBe(false);
    expect(isTelemetryActive(ago(30 * 60_000), NOW, 60)).toBe(true);
  });

  it('counts readings ahead of the clock (accepted skew) as active', () => {
    expect(
      isTelemetryActive(new Date(NOW.getTime() + 4 * 60_000), NOW, 10),
    ).toBe(true);
  });

  it('is inactive without readings', () => {
    expect(isTelemetryActive(null, NOW, 10)).toBe(false);
  });

  it('golden: fixes the legacy /10 000 window (10 s) to minutes (spec §15.5)', () => {
    // [age, legacy result, v2 result with the default W = 10 min]
    const cases: [number, boolean, boolean][] = [
      [5_000, true, true],
      [10_000, true, true],
      [10_001, false, true],
      [60_000, false, true],
      [9 * 60_000, false, true],
      [11 * 60_000, false, false],
    ];
    for (const [ageMs, legacy, v2] of cases) {
      expect([ageMs, legacyIsActive(ago(ageMs), NOW)]).toEqual([ageMs, legacy]);
      expect([ageMs, isTelemetryActive(ago(ageMs), NOW, 10)]).toEqual([
        ageMs,
        v2,
      ]);
    }
  });
});
