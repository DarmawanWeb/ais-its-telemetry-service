import { PageQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
import { trimString } from './create-device.dto.js';

/** Query of `GET /telemetry/devices` (page-based list, spec §5). */
export class ListDevicesQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: 525005223 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({ enum: DEVICE_KINDS })
  @IsOptional()
  @IsIn(DEVICE_KINDS)
  readonly kind?: DeviceKind;

  @ApiPropertyOptional({ enum: DEVICE_STATUSES })
  @IsOptional()
  @IsIn(DEVICE_STATUSES)
  readonly status?: DeviceStatus;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the name or the serial number',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly search?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Organization (platform administrators; others: their own)',
  })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;
}
