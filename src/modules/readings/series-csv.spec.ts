import { describe, expect, it } from 'vitest';

import type { SeriesPoint } from './readings.repository.js';
import {
  csvField,
  SERIES_CSV_HEADER,
  seriesCsv,
  seriesCsvFilename,
  seriesCsvLines,
} from './series-csv.js';

const raw: SeriesPoint = {
  time: new Date('2026-11-21T10:15:00.000Z'),
  fuelMeTon: 1.25,
  fuelAeTon: 0.25,
  readings: 1,
  periodStart: new Date('2026-11-21T10:00:00.000Z'),
  source: 'device',
  deviceId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
};

const hourly: SeriesPoint = {
  time: new Date('2026-11-21T10:00:00.000Z'),
  fuelMeTon: 0.1,
  fuelAeTon: 0.2,
  readings: 3,
  periodStart: null,
  source: null,
  deviceId: null,
};

async function text(chunks: AsyncIterable<string>): Promise<string> {
  let all = '';
  for await (const chunk of chunks) all += chunk;
  return all;
}

async function* batches(
  ...list: (readonly SeriesPoint[])[]
): AsyncGenerator<readonly SeriesPoint[]> {
  for (const batch of list) {
    await Promise.resolve();
    yield batch;
  }
}

describe('series CSV', () => {
  it('has the columns of the web export in a header line with CRLF', () => {
    expect(SERIES_CSV_HEADER).toBe(
      'time,periodStart,fuelMeTon,fuelAeTon,totalFuelTon,readings,source,deviceId\r\n',
    );
  });

  it('writes the values of the JSON points (empty for null, rounded totals)', () => {
    expect(seriesCsvLines([raw, hourly])).toBe(
      '2026-11-21T10:15:00.000Z,2026-11-21T10:00:00.000Z,1.25,0.25,1.5,1,device,0192f3a4-5b6c-7d8e-9f01-23456789abcd\r\n' +
        // 0.1 + 0.2 is 0.30000000000000004 in floating point; totals are rounded like the JSON series.
        '2026-11-21T10:00:00.000Z,,0.1,0.2,0.3,3,,\r\n',
    );
    expect(seriesCsvLines([])).toBe('');
  });

  it('streams the header, then one chunk per batch (an empty export is the header only)', async () => {
    expect(await text(seriesCsv(batches([raw], [hourly])))).toBe(
      SERIES_CSV_HEADER + seriesCsvLines([raw]) + seriesCsvLines([hourly]),
    );
    expect(await text(seriesCsv(batches()))).toBe(SERIES_CSV_HEADER);
  });

  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(0.5)).toBe('0.5');
    expect(csvField(null)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\r\nlines')).toBe('"two\r\nlines"');
  });

  it('names the file after vessel, bucket and range in compact UTC (whole seconds)', () => {
    expect(
      seriesCsvFilename(
        525005223,
        '1h',
        new Date('2026-11-14T10:00:00.000Z'),
        new Date('2026-11-21T10:00:00.250Z'),
      ),
    ).toBe('telemetry-525005223-1h-20261114T100000Z_20261121T100000Z.csv');
  });
});
