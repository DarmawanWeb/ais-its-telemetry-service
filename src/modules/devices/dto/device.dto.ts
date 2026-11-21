import { telemetryMqttTopic } from '@darmawanweb/ais-its-contracts/events';
import { ApiProperty } from '@nestjs/swagger';

import {
  type Device,
  DEVICE_KINDS,
  DEVICE_STATUSES,
  type DeviceKind,
  type DeviceStatus,
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
    description: 'Last readings received from the device (minute resolution)',
  })
  readonly lastSeenAt: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly createdBy: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(device: Device) {
    this.id = device.id;
    this.orgId = device.orgId;
    this.mmsi = device.mmsi;
    this.name = device.name;
    this.kind = device.kind;
    this.apiKeyId = device.apiKeyId;
    this.status = device.status;
    this.serialNumber = device.serialNumber;
    this.mqttTopic =
      device.kind === 'mqtt' ? telemetryMqttTopic(device.id) : null;
    this.lastSeenAt = device.lastSeenAt?.toISOString() ?? null;
    this.createdBy = device.createdBy;
    this.createdAt = device.createdAt.toISOString();
    this.updatedAt = device.updatedAt.toISOString();
  }
}
