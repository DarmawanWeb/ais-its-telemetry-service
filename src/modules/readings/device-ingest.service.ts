import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../common/clock.js';
import { type Config, readingLimitsOf } from '../../config.js';
import {
  batchViolations,
  type ReadingLimits,
} from '../../domain/fuel-reading.js';
import { DevicesService } from '../devices/devices.service.js';
import { VesselsRepository } from '../vessels/vessels.repository.js';
import { deviceIdOfSubject, parseDevicePayload } from './device-payload.js';
import { ReadingIngestService } from './reading-ingest.service.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

/** Outcome of one device message (`aisits_telemetry_device_messages_total{outcome}`). */
export type DeviceMessageOutcome =
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'invalid_subject'
  | 'invalid_json'
  | 'invalid_payload'
  | 'unknown_device'
  | 'inactive_device'
  | 'transport_mismatch'
  | 'vessel_not_found'
  | 'vessel_mismatch';

/** Attempts of the storage step for transient errors (core NATS has no redelivery). */
const STORE_ATTEMPTS = 3;
const STORE_RETRY_BASE_MS = 250;

/**
 * Device messages from the NATS MQTT gateway (core subject
 * `aisits.telemetry.<deviceId>` = MQTT topic `aisits/telemetry/<deviceId>`):
 * the device must be registered, active and of kind `mqtt`; its vessel (the
 * MMSI of the device record) must still belong to the device's organization.
 * Rejected messages are counted by outcome and never stored. Accepted ones
 * enter the shared pipeline with source `mqtt`; readings whose key holds a
 * different reading already (e.g. another meter of the vessel reported the
 * same instant) are left out and the message counts as `conflict`, while
 * the device's other readings are stored (no one could resend them).
 */
@Injectable()
export class DeviceIngestService {
  private readonly logger = new Logger(DeviceIngestService.name);
  private readonly limits: ReadingLimits;

  constructor(
    private readonly devices: DevicesService,
    private readonly vessels: VesselsRepository,
    private readonly ingestion: ReadingIngestService,
    private readonly metrics: TelemetryMetrics,
    @InjectConfig() config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.limits = readingLimitsOf(config);
  }

  /**
   * Handles one message. Storage errors are retried; one that persists is
   * counted (`error`) and thrown (the kit logs it and counts the message as
   * failed: core NATS has no redelivery).
   */
  async handle(
    subject: string,
    data: Uint8Array,
  ): Promise<DeviceMessageOutcome> {
    try {
      const outcome = await this.process(subject, data);
      this.metrics.deviceMessages.inc({ outcome });
      return outcome;
    } catch (error) {
      this.metrics.deviceMessages.inc({ outcome: 'error' });
      throw error;
    }
  }

  private async process(
    subject: string,
    data: Uint8Array,
  ): Promise<DeviceMessageOutcome> {
    const deviceId = deviceIdOfSubject(subject);
    if (deviceId === undefined) {
      this.logger.debug(
        `Ignored device message on ${subject}: not a device subject`,
      );
      return 'invalid_subject';
    }
    const payload = parseDevicePayload(data);
    if (!payload.ok) {
      this.logger.warn(
        { deviceId, reason: payload.reason },
        `Rejected device message: ${payload.message}`,
      );
      return payload.reason;
    }

    const device = await this.devices.deviceForMessage(deviceId);
    if (device === undefined) {
      this.logger.debug(
        { deviceId },
        'Rejected device message: unknown device',
      );
      return 'unknown_device';
    }
    if (device.status !== 'active') {
      this.logger.warn(
        { deviceId },
        'Rejected device message: device inactive',
      );
      return 'inactive_device';
    }
    if (device.kind !== 'mqtt') {
      this.logger.warn(
        { deviceId, kind: device.kind },
        'Rejected device message: not an mqtt device',
      );
      return 'transport_mismatch';
    }
    const [vessel] = await this.vessels.findLive([device.mmsi]);
    if (vessel === undefined) {
      this.logger.warn(
        { deviceId, mmsi: device.mmsi },
        'Rejected device message: vessel not in the fleet',
      );
      return 'vessel_not_found';
    }
    if (vessel.orgId !== device.orgId) {
      this.logger.warn(
        { deviceId, mmsi: device.mmsi },
        'Rejected device message: vessel of another organization',
      );
      return 'vessel_mismatch';
    }

    const now = this.clock.now();
    const readings = payload.readings.map((reading) => ({
      ...reading,
      mmsi: device.mmsi,
    }));
    const violations = batchViolations(readings, this.limits, now);
    if (violations.length > 0) {
      this.metrics.readings.inc(
        { source: 'mqtt', outcome: 'rejected' },
        readings.length,
      );
      this.logger.warn(
        {
          deviceId,
          violations: violations.map(({ index, field, code }) => ({
            index,
            field,
            code,
          })),
        },
        'Rejected device message: implausible readings',
      );
      return 'invalid_payload';
    }

    const result = await withRetries(() =>
      this.ingestion.ingest(
        { readings, source: 'mqtt', deviceId: device.id },
        'skip',
      ),
    );
    await this.devices.markSeen(device, now, result.latest);
    if (result.conflicts > 0) {
      this.logger.warn(
        {
          deviceId,
          mmsi: device.mmsi,
          conflicts: result.conflicts,
          accepted: result.accepted,
        },
        'Device readings conflict with different readings stored for the vessel at the same time; they were not stored',
      );
      return 'conflict';
    }
    return result.accepted > 0 ? 'accepted' : 'duplicate';
  }
}

/** Runs `operation` up to {@link STORE_ATTEMPTS} times with exponential backoff. */
async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= STORE_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, STORE_RETRY_BASE_MS * 2 ** (attempt - 1)),
      );
    }
  }
}
