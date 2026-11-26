import type { FieldError } from '@darmawanweb/ais-its-contracts/api';

import { isTelemetryActive } from '../../domain/telemetry-status.js';

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
  /** When the device last delivered readings (receipt time, {@link LAST_SEEN_RESOLUTION_MS} resolution). */
  readonly lastSeenAt: Date | null;
  /**
   * Measurement time (`time`) of the newest reading stored as the device's
   * (new or an exact repeat, never a refused conflict), written with
   * {@link lastSeenAt} ({@link LAST_SEEN_RESOLUTION_MS} resolution, never
   * moved back).
   */
  readonly lastReadingAt: Date | null;
  /** User who registered the device. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A device with the name of its vessel (FLEET projection). */
export interface DeviceWithVessel extends Device {
  /** `null` while the MMSI is not a live vessel of the FLEET projection. */
  readonly vesselName: string | null;
}

/**
 * Connection state of a device ({@link deviceConnectionState}): `online`,
 * `idle` and `offline` by the age of its newest stored reading, `never`
 * before its first one, `inactive` while it is switched off.
 */
export const DEVICE_CONNECTION_STATES = [
  'online',
  'idle',
  'offline',
  'never',
  'inactive',
] as const;

/** A {@link DEVICE_CONNECTION_STATES} member. */
export type DeviceConnectionState = (typeof DEVICE_CONNECTION_STATES)[number];

/** Age thresholds of {@link deviceConnectionState}, minutes. */
export interface ConnectionThresholds {
  /** `online` up to this age (`TELEMETRY_ACTIVE_WINDOW_MIN`, the "active" window W). */
  readonly activeWindowMin: number;
  /** `offline` beyond this age, `idle` in between (`TELEMETRY_DEVICE_OFFLINE_AFTER_MIN`). */
  readonly offlineAfterMin: number;
}

/** A device as the registry shows it: its vessel's name and its connection state. */
export interface DeviceView extends DeviceWithVessel, ConnectionThresholds {
  readonly connectionState: DeviceConnectionState;
}

/**
 * Connection state of a device from its registry status and the measurement
 * time of its newest reading (`lastReadingAt`):
 *
 * - `inactive` — the device is switched off (its readings are refused),
 *   whatever it delivered before;
 * - `never` — no reading is stored as its own yet (it may have delivered
 *   readings that all conflicted with another producer's);
 * - `online` — its newest reading is at most `activeWindowMin` old: the
 *   "active" rule of a vessel's telemetry ({@link isTelemetryActive}), so the
 *   readings of an online device keep its vessel's telemetry active;
 * - `idle` — older than that, at most `offlineAfterMin`;
 * - `offline` — older than `offlineAfterMin`.
 *
 * The age is measured like the vessel status (readings slightly ahead of the
 * clock, within the accepted skew, are online). A device that forwards old
 * readings is idle or offline until it delivers current ones; its
 * `lastSeenAt` tells when it last delivered anything.
 */
export function deviceConnectionState(
  device: Pick<Device, 'status' | 'lastReadingAt'>,
  now: Date,
  thresholds: ConnectionThresholds,
): DeviceConnectionState {
  if (device.status !== 'active') return 'inactive';
  if (device.lastReadingAt === null) return 'never';
  if (isTelemetryActive(device.lastReadingAt, now, thresholds.activeWindowMin))
    return 'online';
  const ageMs = now.getTime() - device.lastReadingAt.getTime();
  return ageMs <= thresholds.offlineAfterMin * 60_000 ? 'idle' : 'offline';
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

/** CHECK constraint of the credential rule ({@link deviceCredentialError}) of `0001_init.sql`. */
export const DEVICE_CREDENTIAL_CONSTRAINT = 'devices_kind_api_key_check';

/**
 * Resolution of `last_seen_at` / `last_reading_at`, ms: a batch of a device
 * rewrites them only when one of them advances by more than this (a device
 * reporting in real time: about once a minute; one catching up on stored
 * readings: as its newest reading advances).
 */
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
