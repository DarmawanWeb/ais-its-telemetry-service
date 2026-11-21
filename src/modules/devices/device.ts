import type { FieldError } from '@darmawanweb/ais-its-contracts/api';

/**
 * How a device delivers readings: `mqtt` publishes to the MQTT topic
 * `aisits/telemetry/<deviceId>` (NATS MQTT gateway), `http` posts to
 * `POST /api/v2/telemetry/readings` with its own API key (`apiKeyId`).
 */
export const DEVICE_KINDS = ['mqtt', 'http'] as const;

/** A {@link DEVICE_KINDS} member. */
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** `inactive` devices are rejected (MQTT messages and API-key readings). */
export const DEVICE_STATUSES = ['active', 'inactive'] as const;

/** A {@link DEVICE_STATUSES} member. */
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** A fuel meter or gateway of an organization, installed on one vessel. */
export interface Device {
  readonly id: string;
  readonly orgId: string;
  readonly mmsi: number;
  readonly name: string;
  readonly kind: DeviceKind;
  /** API key whose readings are attributed to the device (`http` devices only). */
  readonly apiKeyId: string | null;
  readonly status: DeviceStatus;
  readonly serialNumber: string | null;
  /** Last reading received from the device (updated at most once a minute). */
  readonly lastSeenAt: Date | null;
  /** User who registered the device. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Filters of a device listing. */
export interface DeviceFilter {
  readonly orgId?: string | undefined;
  readonly mmsi?: number | undefined;
  readonly kind?: DeviceKind | undefined;
  readonly status?: DeviceStatus | undefined;
  /** Case-insensitive substring of the name or the serial number. */
  readonly search?: string | undefined;
}

/** Fields a device update may change (`null` clears an optional field). */
export interface DeviceChanges {
  readonly name?: string | undefined;
  readonly mmsi?: number | undefined;
  readonly kind?: DeviceKind | undefined;
  readonly apiKeyId?: string | null | undefined;
  readonly status?: DeviceStatus | undefined;
  readonly serialNumber?: string | null | undefined;
}

/** Unique constraint `(org_id, name)` of `0001_init.sql`. */
export const DEVICE_NAME_CONSTRAINT = 'devices_org_name_key';

/** Unique constraint `(org_id, api_key_id)` of `0001_init.sql`. */
export const DEVICE_API_KEY_CONSTRAINT = 'devices_org_api_key_key';

/** Readings refresh `last_seen_at` at most once per this interval, ms. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

/**
 * Credential rule of a device (mirrors `devices_kind_api_key_check`): an
 * `http` device needs the id of its API key, an `mqtt` device has none.
 *
 * @returns the field error to report, or `undefined` when consistent.
 */
export function deviceCredentialError(
  kind: DeviceKind,
  apiKeyId: string | null,
): FieldError | undefined {
  if (kind === 'http' && apiKeyId === null) {
    return {
      field: 'apiKeyId',
      message: 'apiKeyId is required for http devices',
      code: 'required',
    };
  }
  if (kind === 'mqtt' && apiKeyId !== null) {
    return {
      field: 'apiKeyId',
      message:
        'mqtt devices authenticate at the MQTT gateway and take no apiKeyId',
      code: 'forbidden',
    };
  }
  return undefined;
}
