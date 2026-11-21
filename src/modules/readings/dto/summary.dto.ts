import { ApiProperty } from '@nestjs/swagger';

import {
  type FuelTotals,
  totalFuelTon,
} from '../../../domain/fuel-aggregation.js';

/** Fuel totals of a vessel over a time range. */
export interface FuelSummary extends FuelTotals {
  readonly mmsi: number;
  readonly from: Date;
  readonly to: Date;
}

/** `GET /telemetry/vessels/:mmsi/summary`. */
export class FuelSummaryDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Start of the range (inclusive)',
  })
  readonly from: string;

  @ApiProperty({
    format: 'date-time',
    description: 'End of the range (exclusive)',
  })
  readonly to: string;

  @ApiProperty({
    description: 'Readings whose time lies in the range',
    example: 1440,
  })
  readonly readings: number;

  @ApiProperty({
    description: 'Σ main-engine fuel, t (method telemetry.fuel_reading_usage)',
    example: 25.2,
  })
  readonly fuelMeTon: number;

  @ApiProperty({ description: 'Σ auxiliary-engine fuel, t', example: 3.1 })
  readonly fuelAeTon: number;

  @ApiProperty({ description: 'fuelMeTon + fuelAeTon, t', example: 28.3 })
  readonly totalFuelTon: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly firstReadingAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly lastReadingAt: string | null;

  constructor(summary: FuelSummary) {
    this.mmsi = summary.mmsi;
    this.from = summary.from.toISOString();
    this.to = summary.to.toISOString();
    this.readings = summary.readings;
    this.fuelMeTon = summary.fuelMeTon;
    this.fuelAeTon = summary.fuelAeTon;
    this.totalFuelTon = totalFuelTon(summary.fuelMeTon, summary.fuelAeTon);
    this.firstReadingAt = summary.firstReadingAt?.toISOString() ?? null;
    this.lastReadingAt = summary.lastReadingAt?.toISOString() ?? null;
  }
}
