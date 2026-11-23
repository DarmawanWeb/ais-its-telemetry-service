import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const CHANGELOG = readFileSync(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8',
);

/** The text after the line `heading`, up to the next heading of its level or a higher one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(' ');
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The Markdown list items of `text` that start at `indent`, each with its
 * continuation lines (indented further), as Markdown renders them.
 */
function listItems(text: string, indent = ''): string[] {
  const items: string[][] = [];
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith(`${indent}- `)) {
      current = [line];
      items.push(current);
    } else if (
      current !== undefined &&
      (line === '' || line.startsWith(`${indent}  `))
    ) {
      current.push(line);
    } else {
      current = undefined;
    }
  }
  return items.map((lines) => lines.join('\n'));
}

/** The one item that starts with `start` (after its indentation). */
function item(items: readonly string[], start: string): string {
  const matches = items.filter((candidate) =>
    candidate.trimStart().startsWith(start),
  );
  expect(matches, start).toHaveLength(1);
  return matches[0] ?? '';
}

/** `text` on one line: wrapping and indentation do not change the prose. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The top-level items of the README's Operations section. */
const operations = (): string[] => listItems(section(README, '## Operations'));

/** The CHANGELOG entry of 0.2.0. */
const release = (): string => section(CHANGELOG, '## [0.2.0] - 2026-11-22');

describe('rolling update from 0.1.0', () => {
  // A 0.1.0 FuelSeriesQuery has no `order`, and the platform ValidationPipe
  // forbids unknown properties: every request with `order` (asc included) is a
  // 400 there, and the routes added in 0.2.0 are a 404. A newest-first cursor
  // never reaches a 0.1.0 replica "as ascending": 0.2.0 itself refuses it
  // without `order=desc`.
  const facts = [
    '`order=asc` included',
    '`400 VALIDATION_FAILED`',
    "field: 'order'",
    'readings.csv',
    '/vessels/:mmsi/devices',
    '`404 NOT_FOUND`',
    'only once every telemetry replica runs 0.2.0',
  ];

  it('README Replicas: names what a 0.1.0 replica answers to the new API', () => {
    const replicas = flat(item(operations(), '- **Replicas**'));
    for (const fact of facts) expect(replicas).toContain(fact);
    expect(replicas).not.toContain('read as ascending');
  });

  it('CHANGELOG 0.2.0: the side-by-side claim carries the same caveat', () => {
    const entry = release();
    const intro = flat(entry.slice(0, entry.indexOf('\n### ')));
    expect(intro).toContain('replicas can run side by side');
    for (const fact of facts) expect(intro).toContain(fact);
  });
});

describe('CHANGELOG 0.2.0 :mmsi', () => {
  it('describes the raw-segment parsing that rejects what 0.1.0 coerced', () => {
    const entries = flat(release());
    expect(entries).not.toMatch(/`:mmsi` errors are unchanged/);
    expect(entries).toContain('parsed from the raw path segment');
    // The forms test/readings.int.test.ts checks: 0.1.0 coerced them with
    // `+value` before its MMSI check, the hex one to another MMSI.
    for (const coerced of [
      '`0525005223`',
      '`525005223.0`',
      '`%20525005223`',
      '`5.25005223e8`',
      '`0x1F4A1D67` read vessel 524950887',
    ]) {
      expect(entries).toContain(coerced);
    }
    expect(entries).toContain(
      "now answer `400 VALIDATION_FAILED` (`{ field: 'mmsi', code: 'isMmsi' }`)",
    );
  });
});

describe('README Troubleshooting', () => {
  it('keeps the NATS stall guidance in the relay backlog entry', () => {
    const entries = listItems(
      item(operations(), '- **Troubleshooting**'),
      '  ',
    );
    const backlog = item(
      entries,
      '- _`aisits_telemetry_unpublished_readings` grows',
    );
    expect(flat(backlog)).toContain(
      'While NATS stalls, ingest requests wait at most `TELEMETRY_PUBLISH_TIMEOUT_MS` after the commit',
    );
    expect(
      entries.filter((entry) => entry.includes('While NATS stalls')),
    ).toEqual([backlog]);
    // The entries added in 0.2.0 follow it, each one problem.
    const csv = flat(item(entries, '- _A CSV download ends'));
    expect(csv).not.toContain('NATS');
    expect(csv.endsWith('retry, or narrow the range.')).toBe(true);
    expect(flat(item(entries, '- _Startup warnings_'))).not.toContain(
      'TELEMETRY_PUBLISH_TIMEOUT_MS',
    );
  });
});
