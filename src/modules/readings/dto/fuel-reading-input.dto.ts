import { parseIsoDateTime } from '@darmawanweb/ais-its-contracts/api';
import { MMSI_MAX, MMSI_MIN } from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { IsUtcDateTime } from '../../../common/validation.js';
import type { FuelReadingInput } from '../../../domain/fuel-reading.js';

/** One reading of `POST /telemetry/readings`. */
export class FuelReadingInputDto {
  @ApiProperty({
    description:
      'MMSI of the vessel (must belong to the organization of the caller)',
    example: 525005223,
    minimum: MMSI_MIN,
    maximum: MMSI_MAX,
  })
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi!: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-21T10:00:00Z',
    description:
      'End of the measured period, ISO-8601 UTC (millisecond precision; at most TELEMETRY_MAX_FUTURE_SKEW_MIN ahead and TELEMETRY_MAX_AGE_DAYS old)',
  })
  @IsUtcDateTime()
  readonly time!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-21T09:00:00Z',
    description:
      'Start of the measured period (before `time`, at most TELEMETRY_MAX_PERIOD_H earlier)',
  })
  @IsOptional()
  @IsUtcDateTime()
  readonly periodStart?: string | null;

  @ApiProperty({
    description:
      'Main-engine fuel burnt in the period, t (≥ 0, ≤ TELEMETRY_MAX_FUEL_ME_TON)',
    example: 0.42,
    minimum: 0,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  readonly fuelMeTon!: number;

  @ApiProperty({
    description:
      'Auxiliary-engine fuel burnt in the period, t (≥ 0, ≤ TELEMETRY_MAX_FUEL_AE_TON)',
    example: 0.05,
    minimum: 0,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  readonly fuelAeTon!: number;
}

/** The domain input of a validated reading DTO. */
export function toFuelReadingInput(dto: FuelReadingInputDto): FuelReadingInput {
  return {
    mmsi: dto.mmsi,
    time: parseIsoDateTime(dto.time),
    periodStart:
      dto.periodStart === undefined || dto.periodStart === null
        ? null
        : parseIsoDateTime(dto.periodStart),
    fuelMeTon: dto.fuelMeTon,
    fuelAeTon: dto.fuelAeTon,
  };
}
