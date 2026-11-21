import { subjects } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import { deviceIdOfSubject, parseDevicePayload } from './device-payload.js';

const DEVICE_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe('deviceIdOfSubject', () => {
  it('reads the device id of aisits.telemetry.<deviceId>', () => {
    expect(deviceIdOfSubject(subjects.telemetryMqtt(DEVICE_ID))).toBe(
      DEVICE_ID,
    );
    expect(
      deviceIdOfSubject(`aisits.telemetry.${DEVICE_ID.toUpperCase()}`),
    ).toBe(DEVICE_ID);
  });

  it('refuses other subjects and tokens that are not UUIDs', () => {
    expect(deviceIdOfSubject('aisits.telemetry.meter-1')).toBeUndefined();
    expect(deviceIdOfSubject(`fuel.reading.v1.${DEVICE_ID}`)).toBeUndefined();
    expect(
      deviceIdOfSubject(`aisits.telemetry.${DEVICE_ID}.extra`),
    ).toBeUndefined();
  });
});

describe('parseDevicePayload', () => {
  it('parses one reading and ignores unknown members', () => {
    const result = parseDevicePayload(
      encode({
        time: '2026-11-21T10:00:00Z',
        fuelMeTon: 0.4,
        fuelAeTon: 0.05,
        rpm: 92,
      }),
    );
    expect(result).toEqual({
      ok: true,
      readings: [
        {
          time: new Date('2026-11-21T10:00:00Z'),
          periodStart: null,
          fuelMeTon: 0.4,
          fuelAeTon: 0.05,
        },
      ],
    });
  });

  it('parses an array of readings with periods (store and forward)', () => {
    const result = parseDevicePayload(
      encode([
        {
          time: '2026-11-21T10:00:00Z',
          periodStart: '2026-11-21T09:00:00Z',
          fuelMeTon: 1,
          fuelAeTon: 0.1,
        },
        {
          time: '2026-11-21T11:00:00Z',
          periodStart: null,
          fuelMeTon: 2,
          fuelAeTon: 0.2,
        },
      ]),
    );
    expect(
      result.ok &&
        result.readings.map((r) => r.periodStart?.toISOString() ?? null),
    ).toEqual(['2026-11-21T09:00:00.000Z', null]);
  });

  it('rejects bodies that are not UTF-8 JSON', () => {
    expect(parseDevicePayload(new TextEncoder().encode('fuel=1')).ok).toBe(
      false,
    );
    expect(
      parseDevicePayload(new Uint8Array([0xff, 0xfe, 0x7b])),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_json',
    });
  });

  it('rejects readings with missing fields, local times or no readings', () => {
    for (const body of [
      { time: '2026-11-21T10:00:00Z', fuelMeTon: 1 },
      { time: '2026-11-21T10:00:00+08:00', fuelMeTon: 1, fuelAeTon: 0 },
      { time: '2026-11-21T10:00:00Z', fuelMeTon: '1', fuelAeTon: 0 },
      [],
      42,
    ]) {
      expect(parseDevicePayload(encode(body))).toMatchObject({
        ok: false,
        reason: 'invalid_payload',
      });
    }
  });
});
