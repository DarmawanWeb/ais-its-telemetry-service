import {
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  FUEL_BUCKETS,
  type FuelBucket,
  totalFuelTon,
} from '../../../domain/fuel-aggregation.js';
import {
  FUEL_READING_SOURCES,
  type FuelReadingSource,
} from '../../../domain/fuel-reading.js';
import type { SeriesPoint } from '../readings.repository.js';

/** Query of `GET /telemetry/vessels/:mmsi/readings` (cursor-based, time-ordered). */
export class FuelSeriesQuery extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
) {
  @ApiPropertyOptional({
    enum: FUEL_BUCKETS,
    default: 'raw',
    description:
      '`raw` readings (default range 24 h, at most 31 d), `1h` hourly sums (7 d, ≤ 366 d) or `1d` daily sums (365 d, ≤ 5 y); buckets are UTC and come from the continuous aggregates fuel_hourly / fuel_daily',
  })
  @IsOptional()
  @IsIn(FUEL_BUCKETS)
  readonly bucket: FuelBucket = 'raw';
}

/** A point of a fuel series: a reading, or the sums of a UTC bucket. */
export class FuelSeriesPointDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Reading time, or bucket start',
  })
  readonly time: string;

  @ApiProperty({ description: 'Main-engine fuel, t', example: 0.42 })
  readonly fuelMeTon: number;

  @ApiProperty({ description: 'Auxiliary-engine fuel, t', example: 0.05 })
  readonly fuelAeTon: number;

  @ApiProperty({ description: 'fuelMeTon + fuelAeTon, t', example: 0.47 })
  readonly totalFuelTon: number;

  @ApiProperty({
    description: 'Readings in the point (1 for raw readings)',
    example: 1,
  })
  readonly readings: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Start of the measured period (raw readings)',
  })
  readonly periodStart: string | null;

  @ApiProperty({
    enum: FUEL_READING_SOURCES,
    nullable: true,
    description: 'Raw readings only',
  })
  readonly source: FuelReadingSource | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Raw readings only',
  })
  readonly deviceId: string | null;

  constructor(point: SeriesPoint) {
    this.time = point.time.toISOString();
    this.fuelMeTon = point.fuelMeTon;
    this.fuelAeTon = point.fuelAeTon;
    this.totalFuelTon = totalFuelTon(point.fuelMeTon, point.fuelAeTon);
    this.readings = point.readings;
    this.periodStart = point.periodStart?.toISOString() ?? null;
    this.source = point.source;
    this.deviceId = point.deviceId;
  }
}
