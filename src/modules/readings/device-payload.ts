import {
  IsoDateTimeSchema,
  parseIsoDateTime,
} from '@darmawanweb/ais-its-contracts/api';
import { SUBJECT_FILTERS } from '@darmawanweb/ais-its-contracts/events';
import * as z from 'zod';

import { MAX_READINGS_PER_BATCH } from '../../domain/fuel-reading.js';

/** Prefix of the core subjects of device messages, `aisits.telemetry.` (contracts `telemetry-mqtt`). */
const DEVICE_SUBJECT_PREFIX = SUBJECT_FILTERS.TELEMETRY_MQTT.slice(0, -1);

const DeviceIdSchema = z.uuid();

/**
 * One reading of a device message (spec §13.4). The vessel is the device's
 * (no `mmsi` field); other members are ignored so that firmware may add
 * fields. Plausibility rules are applied afterwards, as for REST.
 */
const DeviceReadingSchema = z.object({
  time: IsoDateTimeSchema,
  periodStart: IsoDateTimeSchema.nullish(),
  fuelMeTon: z.number(),
  fuelAeTon: z.number(),
});

/** A device message: one reading, or up to {@link MAX_READINGS_PER_BATCH} (store and forward). */
const DevicePayloadSchema = z.union([
  DeviceReadingSchema,
  z.array(DeviceReadingSchema).min(1).max(MAX_READINGS_PER_BATCH),
]);

/** A reading of a device message, before the vessel is known. */
export interface DeviceReading {
  readonly time: Date;
  readonly periodStart: Date | null;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
}

/** Result of {@link parseDevicePayload}. */
export type DevicePayloadResult =
  | { readonly ok: true; readonly readings: DeviceReading[] }
  | {
      readonly ok: false;
      readonly reason: 'invalid_json' | 'invalid_payload';
      readonly message: string;
    };

/**
 * The device id of a core subject `aisits.telemetry.<deviceId>` (MQTT topic
 * `aisits/telemetry/<deviceId>`), or `undefined` when it is not a UUID.
 */
export function deviceIdOfSubject(subject: string): string | undefined {
  if (!subject.startsWith(DEVICE_SUBJECT_PREFIX)) return undefined;
  const token = subject.slice(DEVICE_SUBJECT_PREFIX.length);
  return DeviceIdSchema.safeParse(token).success
    ? token.toLowerCase()
    : undefined;
}

/**
 * Parses a device message body (UTF-8 JSON `{ time, periodStart?, fuelMeTon,
 * fuelAeTon }` or an array of them).
 */
export function parseDevicePayload(data: Uint8Array): DevicePayloadResult {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return {
      ok: false,
      reason: 'invalid_json',
      message: 'the message is not UTF-8 JSON',
    };
  }
  const parsed = DevicePayloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_payload',
      message: z.prettifyError(parsed.error),
    };
  }
  const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return {
    ok: true,
    readings: items.map((item) => ({
      time: parseIsoDateTime(item.time),
      periodStart:
        item.periodStart === undefined || item.periodStart === null
          ? null
          : parseIsoDateTime(item.periodStart),
      fuelMeTon: item.fuelMeTon,
      fuelAeTon: item.fuelAeTon,
    })),
  };
}
