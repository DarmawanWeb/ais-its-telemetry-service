import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  DEVICE_KINDS,
  DEVICE_STATUSES,
  type DeviceKind,
  type DeviceStatus,
} from '../device.js';

/** Trims string input before validation (other values pass unchanged). */
export function trimString(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  return typeof input === 'string' ? input.trim() : input;
}

/** `POST /telemetry/devices`. */
export class CreateDeviceDto {
  @ApiProperty({
    description:
      'MMSI of the vessel the device is installed on (its organization owns the device)',
    example: 525005223,
    minimum: 100_000_000,
    maximum: 999_999_999,
  })
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi!: number;

  @ApiProperty({
    description: 'Unique within the organization',
    minLength: 1,
    maxLength: 120,
    example: 'ME flow meter',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly name!: string;

  @ApiProperty({
    enum: DEVICE_KINDS,
    description:
      '`mqtt`: publishes to MQTT topic `aisits/telemetry/<id>`; `http`: posts readings with its API key',
  })
  @IsIn(DEVICE_KINDS)
  readonly kind!: DeviceKind;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Id of the API key (scope `telemetry:ingest`) of an http device; required for http, refused for mqtt',
  })
  @IsOptional()
  @IsUUID()
  readonly apiKeyId?: string;

  @ApiPropertyOptional({ enum: DEVICE_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(DEVICE_STATUSES)
  readonly status?: DeviceStatus;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 120,
    example: 'FM-2041-0007',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly serialNumber?: string;
}
