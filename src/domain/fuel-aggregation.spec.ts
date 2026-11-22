import { describe, expect, it } from 'vitest';

import {
  addTotals,
  ceilToBucket,
  EMPTY_TOTALS,
  floorToBucket,
  type FuelTotals,
  planSummaryPieces,
  roundFuelSum,
  type SummaryPiece,
  totalFuelTon,
} from './fuel-aggregation.js';

const t = (iso: string) => new Date(iso);

/** Pieces as `source from→to` strings (ISO without seconds) for readable expectations. */
function describePieces(pieces: readonly SummaryPiece[]): string[] {
  const short = (date: Date) => date.toISOString().slice(0, 16);
  return pieces.map(
    (piece) => `${piece.source} ${short(piece.from)}→${short(piece.to)}`,
  );
}

describe('floorToBucket / ceilToBucket', () => {
  it('align to UTC hours and days like time_bucket', () => {
    const date = t('2026-11-21T10:37:12.345Z');
    expect(floorToBucket(date, '1h').toISOString()).toBe(
      '2026-11-21T10:00:00.000Z',
    );
    expect(ceilToBucket(date, '1h').toISOString()).toBe(
      '2026-11-21T11:00:00.000Z',
    );
    expect(floorToBucket(date, '1d').toISOString()).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    expect(ceilToBucket(date, '1d').toISOString()).toBe(
      '2026-11-22T00:00:00.000Z',
    );
  });

  it('keep aligned dates', () => {
    const midnight = t('2026-11-21T00:00:00.000Z');
    expect(floorToBucket(midnight, '1d')).toEqual(midnight);
    expect(ceilToBucket(midnight, '1d')).toEqual(midnight);
    expect(ceilToBucket(midnight, '1h')).toEqual(midnight);
  });
});

describe('planSummaryPieces', () => {
  it('uses whole days, then whole hours, then raw edges', () => {
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T10:30:00Z'), t('2026-11-03T02:15:00Z')),
      ),
    ).toEqual([
      'raw 2026-11-01T10:30→2026-11-01T11:00',
      '1h 2026-11-01T11:00→2026-11-02T00:00',
      '1d 2026-11-02T00:00→2026-11-03T00:00',
      '1h 2026-11-03T00:00→2026-11-03T02:00',
      'raw 2026-11-03T02:00→2026-11-03T02:15',
    ]);
  });

  it('reads aligned ranges from the aggregates only', () => {
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T00:00:00Z'), t('2026-11-08T00:00:00Z')),
      ),
    ).toEqual(['1d 2026-11-01T00:00→2026-11-08T00:00']);
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T06:00:00Z'), t('2026-11-01T09:00:00Z')),
      ),
    ).toEqual(['1h 2026-11-01T06:00→2026-11-01T09:00']);
  });

  it('uses hours when no whole day fits', () => {
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T22:10:00Z'), t('2026-11-02T03:00:00Z')),
      ),
    ).toEqual([
      'raw 2026-11-01T22:10→2026-11-01T23:00',
      '1h 2026-11-01T23:00→2026-11-02T03:00',
    ]);
  });

  it('reads short ranges inside one hour from the raw readings', () => {
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T10:05:00Z'), t('2026-11-01T10:55:00Z')),
      ),
    ).toEqual(['raw 2026-11-01T10:05→2026-11-01T10:55']);
    expect(
      describePieces(
        planSummaryPieces(t('2026-11-01T10:30:00Z'), t('2026-11-01T11:20:00Z')),
      ),
    ).toEqual(['raw 2026-11-01T10:30→2026-11-01T11:20']);
  });

  it('returns nothing for an empty range', () => {
    const at = t('2026-11-01T10:00:00Z');
    expect(planSummaryPieces(at, at)).toEqual([]);
    expect(planSummaryPieces(t('2026-11-02T00:00:00Z'), at)).toEqual([]);
  });

  it('covers any range exactly once with contiguous pieces', () => {
    const start = t('2026-10-30T00:00:00Z').getTime();
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 500; run += 1) {
      const from = new Date(start + Math.floor(random() * 5 * 86_400_000));
      const to = new Date(
        from.getTime() + Math.floor(random() * 4 * 86_400_000),
      );
      const pieces = planSummaryPieces(from, to);
      if (from.getTime() === to.getTime()) continue;
      expect(pieces[0]?.from).toEqual(from);
      expect(pieces.at(-1)?.to).toEqual(to);
      pieces.forEach((piece, index) => {
        expect(piece.from.getTime()).toBeLessThan(piece.to.getTime());
        if (index > 0) expect(piece.from).toEqual(pieces[index - 1]?.to);
        if (piece.source !== 'raw') {
          const width = piece.source === '1h' ? 3_600_000 : 86_400_000;
          expect(piece.from.getTime() % width).toBe(0);
          expect(piece.to.getTime() % width).toBe(0);
        }
      });
    }
  });
});

describe('addTotals / totalFuelTon (telemetry.fuel_reading_usage)', () => {
  const a: FuelTotals = {
    readings: 2,
    fuelMeTon: 1.5,
    fuelAeTon: 0.25,
    firstReadingAt: t('2026-11-01T10:15:00Z'),
    lastReadingAt: t('2026-11-01T10:45:00Z'),
  };
  const b: FuelTotals = {
    readings: 1,
    fuelMeTon: 2,
    fuelAeTon: 0.5,
    firstReadingAt: t('2026-11-01T09:05:00Z'),
    lastReadingAt: t('2026-11-01T09:05:00Z'),
  };

  it('sums readings and fuel per engine group and spans first/last times', () => {
    expect(addTotals(a, b)).toEqual({
      readings: 3,
      fuelMeTon: 3.5,
      fuelAeTon: 0.75,
      firstReadingAt: t('2026-11-01T09:05:00Z'),
      lastReadingAt: t('2026-11-01T10:45:00Z'),
    });
  });

  it('has the empty totals as neutral element', () => {
    expect(addTotals(EMPTY_TOTALS, a)).toEqual(a);
    expect(addTotals(a, EMPTY_TOTALS)).toEqual(a);
    expect([a, b, EMPTY_TOTALS].reduce(addTotals, EMPTY_TOTALS)).toEqual(
      addTotals(a, b),
    );
  });

  it('golden: total = ME + AE as legacy totalFuelConsumptionTon', () => {
    // legacy cii.service.ts: Number(fuelAE.toString()) + Number(fuelME.toString())
    expect(totalFuelTon(Number('1.25'), Number('0.75'))).toBe(2);
    expect(totalFuelTon(0.42, 0.05)).toBeCloseTo(0.47, 12);
  });

  it('reports sums without binary floating-point artifacts', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(totalFuelTon(0.1, 0.2)).toBe(0.3);
    expect(totalFuelTon(0.42, 0.05)).toBe(0.47);
    const tenths = { ...EMPTY_TOTALS, readings: 1, fuelMeTon: 0.1 };
    expect(addTotals(tenths, { ...tenths, fuelMeTon: 0.2 }).fuelMeTon).toBe(
      0.3,
    );
  });
});

describe('roundFuelSum', () => {
  it('rounds to 1 mg (9 decimals of a tonne) and keeps exact values', () => {
    expect(roundFuelSum(0.30000000000000004)).toBe(0.3);
    expect(roundFuelSum(15.400000000000002)).toBe(15.4);
    expect(roundFuelSum(182_500.123456789)).toBe(182_500.123456789);
    expect(roundFuelSum(1.5)).toBe(1.5);
    expect(roundFuelSum(0)).toBe(0);
    expect(roundFuelSum(4e-10)).toBe(0);
    expect(roundFuelSum(6e-10)).toBe(1e-9);
  });

  it('leaves values unchanged that cannot be scaled exactly', () => {
    expect(roundFuelSum(1e7 + 0.1)).toBe(1e7 + 0.1);
    expect(roundFuelSum(Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(roundFuelSum(Number.NaN)).toBeNaN();
  });
});
