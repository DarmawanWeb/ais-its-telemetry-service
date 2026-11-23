import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { IsUtcDateTime } from './validation.js';

class Probe {
  @IsUtcDateTime()
  readonly time!: unknown;

  constructor(time: unknown) {
    this.time = time;
  }
}

describe('IsUtcDateTime', () => {
  it('accepts ISO-8601 UTC timestamps', () => {
    for (const time of [
      '2026-11-21T10:00:00Z',
      '2026-11-21T10:00:00.123Z',
      '2024-02-29T00:00:00Z',
    ]) {
      expect(validateSync(new Probe(time))).toEqual([]);
    }
  });

  it('refuses offsets, local times, impossible dates and other types', () => {
    for (const time of [
      '2026-11-21T10:00:00+08:00',
      '2026-11-21T10:00:00',
      '2026-02-30T00:00:00Z',
      1_700_000_000_000,
      null,
    ]) {
      const [error] = validateSync(new Probe(time));
      expect(error?.constraints).toEqual({
        isUtcDateTime:
          'time must be an ISO-8601 UTC timestamp such as 2026-11-21T10:00:00Z',
      });
    }
  });
});
