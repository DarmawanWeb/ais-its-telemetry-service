import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { describe, expect, it } from 'vitest';

import { ParseReadingsBodyPipe } from './parse-readings-body.pipe.js';

const pipe = new ParseReadingsBodyPipe();
const valid = {
  mmsi: 525005223,
  time: '2026-11-21T10:00:00Z',
  fuelMeTon: 0.4,
  fuelAeTon: 0.05,
};

/** The field errors of a rejected body. */
async function errorsOf(body: unknown): Promise<string[]> {
  const error: unknown = await pipe.transform(body).then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(ValidationFailedError);
  return ((error as ValidationFailedError).errors ?? []).map(
    (e) => `${e.field}:${e.code ?? ''}`,
  );
}

describe('ParseReadingsBodyPipe', () => {
  it('accepts one reading object as a batch of one', async () => {
    const readings = await pipe.transform(valid);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject(valid);
  });

  it('accepts an array with optional periods', async () => {
    const readings = await pipe.transform([
      valid,
      {
        ...valid,
        time: '2026-11-21T11:00:00Z',
        periodStart: '2026-11-21T10:00:00Z',
      },
      { ...valid, time: '2026-11-21T12:00:00Z', periodStart: null },
    ]);
    expect(readings).toHaveLength(3);
  });

  it('reports field errors as <index>.<field>', async () => {
    expect(
      await errorsOf([
        valid,
        { ...valid, mmsi: 12345, fuelMeTon: -1 },
        { ...valid, time: '2026-11-21 10:00' },
      ]),
    ).toEqual(['1.mmsi:min', '1.fuelMeTon:min', '2.time:isUtcDateTime']);
  });

  it('rejects unknown properties and non-object items', async () => {
    expect(await errorsOf([{ ...valid, deviceId: 'x' }, 'reading'])).toEqual([
      '0.deviceId:whitelistValidation',
      '1:isObject',
    ]);
    expect(await errorsOf(null)).toEqual(['0:isObject']);
  });

  it('accepts 1 to 1000 readings', async () => {
    expect(await errorsOf([])).toEqual(['body:arrayMinSize']);
    expect(await errorsOf(Array.from({ length: 1001 }, () => valid))).toEqual([
      'body:arrayMaxSize',
    ]);
    await expect(
      pipe.transform(Array.from({ length: 1000 }, () => valid)),
    ).resolves.toHaveLength(1000);
  });
});
