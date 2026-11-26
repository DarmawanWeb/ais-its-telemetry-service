import { ApiProperty } from '@nestjs/swagger';

import {
  type Device,
  DEVICE_KINDS,
  DEVICE_STATUSES,
  type DeviceKind,
  type DeviceStatus,
} from '../device.js';

/**
 * A device of a vessel as `telemetry:read` sees it: what it is and whether
 * it reports, without the registry fields of `device:manage` (API key,
 * serial number, MQTT topic, creator).
 */
export class VesselDeviceDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Device id (the `deviceId` of its raw readings)',
  })
  readonly id: string;

  @ApiProperty({ example: 'ME flow meter' })
  readonly name: string;

  @ApiProperty({ enum: DEVICE_KINDS })
  readonly kind: DeviceKind;

  @ApiProperty({
    enum: DEVICE_STATUSES,
    description: 'Registry status: readings of inactive devices are rejected',
  })
  readonly status: DeviceStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the device last delivered readings (receipt time, minute resolution)',
  })
  readonly lastSeenAt: string | null;

  constructor(device: Device) {
    this.id = device.id;
    this.name = device.name;
    this.kind = device.kind;
    this.status = device.status;
    this.lastSeenAt = device.lastSeenAt?.toISOString() ?? null;
  }
}
