import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  DEVICE_KINDS,
  DEVICE_STATUSES,
  type DeviceKind,
  type DeviceStatus,
} from '../device.js';
import { trimString } from './create-device.dto.js';

/** `PATCH /telemetry/devices/:id`: absent fields are kept, `null` clears an optional one. */
export class UpdateDeviceDto {
  @ApiPropertyOptional({
    description: 'Move the device to another vessel of the same organization',
    minimum: 100_000_000,
    maximum: 999_999_999,
  })
  @IsOptional()
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly name?: string;

  @ApiPropertyOptional({ enum: DEVICE_KINDS })
  @IsOptional()
  @IsIn(DEVICE_KINDS)
  readonly kind?: DeviceKind;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'API key of an http device; `null` unlinks it (required for http devices)',
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  readonly apiKeyId?: string | null;

  @ApiPropertyOptional({ enum: DEVICE_STATUSES })
  @IsOptional()
  @IsIn(DEVICE_STATUSES)
  readonly status?: DeviceStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @Transform(trimString)
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Length(1, 120)
  readonly serialNumber?: string | null;
}
