import type { FuelBucket } from '../../domain/fuel-aggregation.js';
import { FuelSeriesPointDto } from './dto/series.dto.js';
import type { SeriesPoint } from './readings.repository.js';

/**
 * Columns of the CSV export: the fields of {@link FuelSeriesPointDto}, in
 * the order the web app's client-side export used.
 */
export const SERIES_CSV_COLUMNS = [
  'time',
  'periodStart',
  'fuelMeTon',
  'fuelAeTon',
  'totalFuelTon',
  'readings',
  'source',
  'deviceId',
] as const satisfies readonly (keyof FuelSeriesPointDto)[];

/** Media type of the export: RFC 4180 CSV with a header line, UTF-8. */
export const SERIES_CSV_MEDIA_TYPE = 'text/csv; charset=utf-8; header=present';

/** Line break of RFC 4180. */
const CRLF = '\r\n';

/** The header line of the export. */
export const SERIES_CSV_HEADER = SERIES_CSV_COLUMNS.join(',') + CRLF;

/**
 * One CSV field (RFC 4180): empty for `null`, quoted (quotes doubled) when
 * it holds a comma, a quote or a line break. The exported values are
 * timestamps, numbers, enum members and UUIDs, so quoting is a safeguard.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The lines of a batch of points, with the values of the JSON series. */
export function seriesCsvLines(points: readonly SeriesPoint[]): string {
  let lines = '';
  for (const point of points) {
    const dto = new FuelSeriesPointDto(point);
    lines +=
      SERIES_CSV_COLUMNS.map((column) => csvField(dto[column])).join(',') +
      CRLF;
  }
  return lines;
}

/** The export as text chunks: the header line, then one chunk per batch. */
export async function* seriesCsv(
  batches: AsyncIterable<readonly SeriesPoint[]>,
): AsyncGenerator<string> {
  yield SERIES_CSV_HEADER;
  for await (const batch of batches) yield seriesCsvLines(batch);
}

/**
 * File name of an export, `telemetry-<mmsi>-<bucket>-<from>_<to>.csv` with
 * compact UTC times to the second (`20261121T100000Z`: no characters file
 * systems refuse).
 */
export function seriesCsvFilename(
  mmsi: number,
  bucket: FuelBucket,
  from: Date,
  to: Date,
): string {
  return `telemetry-${mmsi}-${bucket}-${compactUtc(from)}_${compactUtc(to)}.csv`;
}

function compactUtc(time: Date): string {
  return time
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
}
