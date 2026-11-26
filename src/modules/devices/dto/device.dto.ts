import { telemetryMqttTopic } from '@darmawanweb/ais-its-contracts/events';
import { ApiProperty } from '@nestjs/swagger';

import {
  DEVICE_CONNECTION_STATES,
  DEVICE_KINDS,
  DEVICE_STATUSES,
  type DeviceConnectionState,
  type DeviceKind,
  type DeviceStatus,
  type DeviceView,
} from '../device.js';

/** A device on the wire (dates as ISO-8601 UTC strings, spec §2). */
export class DeviceDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ format: 'uuid', description: 'Organization of the vessel' })
  readonly orgId: string;

  @ApiProperty({
    example: 525005223,
    description: 'Vessel the device is installed on',
  })
  readonly mmsi: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'KM Sinar Bahari',
    description:
      'Name of the vessel (FLEET projection); null while the MMSI is not a live vessel of the fleet',
  })
  readonly vesselName: string | null;

  @ApiProperty({ example: 'ME flow meter' })
  readonly name: string;

  @ApiProperty({ enum: DEVICE_KINDS })
  readonly kind: DeviceKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'API key of an http device; its readings are attributed to the device',
  })
  readonly apiKeyId: string | null;

  @ApiProperty({ enum: DEVICE_STATUSES })
  readonly status: DeviceStatus;

  @ApiProperty({ type: String, nullable: true, example: 'FM-2041-0007' })
  readonly serialNumber: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'aisits/telemetry/0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77',
    description: 'MQTT topic the device publishes to (mqtt devices)',
  })
  readonly mqttTopic: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the device last delivered readings (receipt time, minute resolution)',
  })
  readonly lastSeenAt: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Measurement time of the newest reading stored as the device’s on its current vessel (minute resolution, written with lastSeenAt; never moves back; ' +
      'null again after a move to another vessel, until the first reading there)',
  })
  readonly lastReadingAt: string | null;

  @ApiProperty({
    enum: DEVICE_CONNECTION_STATES,
    description:
      'inactive: switched off (readings refused); never: no reading on its current vessel yet; online: newest reading at most activeWindowMin old ' +
      '(the vessel telemetry "active" rule, method fuel.method_selection: its vessel’s telemetry is active); idle: older, up to offlineAfterMin; ' +
      'offline: older than offlineAfterMin',
  })
  readonly connectionState: DeviceConnectionState;

  @ApiProperty({
    example: 10,
    description:
      'Age of the newest reading up to which the device is online, minutes (TELEMETRY_ACTIVE_WINDOW_MIN)',
  })
  readonly activeWindowMin: number;

  @ApiProperty({
    example: 1440,
    description:
      'Age of the newest reading beyond which the device is offline, minutes (TELEMETRY_DEVICE_OFFLINE_AFTER_MIN)',
  })
  readonly offlineAfterMin: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly createdBy: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(device: DeviceView) {
    this.id = device.id;
    this.orgId = device.orgId;
    this.mmsi = device.mmsi;
    this.vesselName = device.vesselName;
    this.name = device.name;
    this.kind = device.kind;
    this.apiKeyId = device.apiKeyId;
    this.status = device.status;
    this.serialNumber = device.serialNumber;
    this.mqttTopic =
      device.kind === 'mqtt' ? telemetryMqttTopic(device.id) : null;
    this.lastSeenAt = device.lastSeenAt?.toISOString() ?? null;
    this.lastReadingAt = device.lastReadingAt?.toISOString() ?? null;
    this.connectionState = device.connectionState;
    this.activeWindowMin = device.activeWindowMin;
    this.offlineAfterMin = device.offlineAfterMin;
    this.createdBy = device.createdBy;
    this.createdAt = device.createdAt.toISOString();
    this.updatedAt = device.updatedAt.toISOString();
  }
}
