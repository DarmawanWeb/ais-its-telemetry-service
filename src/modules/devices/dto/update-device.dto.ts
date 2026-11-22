import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
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

/**
 * Validates a field only when it is present: unlike `@IsOptional()`, which
 * also skips `null`, a `null` then fails the field's validators (`400`), so
 * it can never reach a NOT NULL column.
 */
const IfPresent = () =>
  ValidateIf((_object: object, value: unknown) => value !== undefined);

/** Validates a field unless it is absent or `null` (the nullable fields: `null` clears them). */
const IfPresentAndNotNull = () =>
  ValidateIf(
    (_object: object, value: unknown) => value !== undefined && value !== null,
  );

/**
 * `PATCH /telemetry/devices/:id`: absent fields are kept, `null` clears
 * `apiKeyId` / `serialNumber`; `mmsi`, `name`, `kind` and `status` cannot
 * be `null`.
 */
export class UpdateDeviceDto {
  @ApiPropertyOptional({
    description: 'Move the device to another vessel of the same organization',
    minimum: 100_000_000,
    maximum: 999_999_999,
  })
  @IfPresent()
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IfPresent()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly name?: string;

  @ApiPropertyOptional({ enum: DEVICE_KINDS })
  @IfPresent()
  @IsIn(DEVICE_KINDS)
  readonly kind?: DeviceKind;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'API key of an http device; `null` unlinks it (required for http devices)',
  })
  @IfPresentAndNotNull()
  @IsUUID()
  readonly apiKeyId?: string | null;

  @ApiPropertyOptional({ enum: DEVICE_STATUSES })
  @IfPresent()
  @IsIn(DEVICE_STATUSES)
  readonly status?: DeviceStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @Transform(trimString)
  @IfPresentAndNotNull()
  @IsString()
  @Length(1, 120)
  readonly serialNumber?: string | null;
}
