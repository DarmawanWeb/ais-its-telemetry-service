import { ApiProperty } from '@nestjs/swagger';

import { totalFuelTon } from '../../../domain/fuel-aggregation.js';
import {
  FUEL_READING_SOURCES,
  type FuelReadingSource,
} from '../../../domain/fuel-reading.js';
import type { StoredReading } from '../reading.js';

/** A stored reading on the wire. */
export class FuelReadingDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({ format: 'date-time' })
  readonly time: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly periodStart: string | null;

  @ApiProperty({ description: 'Main-engine fuel, t' })
  readonly fuelMeTon: number;

  @ApiProperty({ description: 'Auxiliary-engine fuel, t' })
  readonly fuelAeTon: number;

  @ApiProperty({ description: 'fuelMeTon + fuelAeTon, t' })
  readonly totalFuelTon: number;

  @ApiProperty({ enum: FUEL_READING_SOURCES })
  readonly source: FuelReadingSource;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly deviceId: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When the service stored the reading',
  })
  readonly receivedAt: string;

  constructor(reading: StoredReading) {
    this.mmsi = reading.mmsi;
    this.time = reading.time.toISOString();
    this.periodStart = reading.periodStart?.toISOString() ?? null;
    this.fuelMeTon = reading.fuelMeTon;
    this.fuelAeTon = reading.fuelAeTon;
    this.totalFuelTon = totalFuelTon(reading.fuelMeTon, reading.fuelAeTon);
    this.source = reading.source;
    this.deviceId = reading.deviceId;
    this.receivedAt = reading.receivedAt.toISOString();
  }
}

/** Telemetry status of a vessel (`GET /telemetry/vessels/:mmsi/status`). */
export interface TelemetryStatus {
  readonly mmsi: number;
  readonly active: boolean;
  readonly activeWindowMin: number;
  readonly lastReading: StoredReading | null;
}

/** `GET /telemetry/vessels/:mmsi/status` (legacy `FuelDataRepository.isActive` / `getLatestByMMSI`). */
export class TelemetryStatusDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({
    description:
      'Newest reading at most activeWindowMin minutes old (method fuel.method_selection)',
  })
  readonly active: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Time of the newest reading',
  })
  readonly lastReadingAt: string | null;

  @ApiProperty({ description: 'TELEMETRY_ACTIVE_WINDOW_MIN', example: 10 })
  readonly activeWindowMin: number;

  @ApiProperty({ type: FuelReadingDto, nullable: true })
  readonly lastReading: FuelReadingDto | null;

  constructor(status: TelemetryStatus) {
    this.mmsi = status.mmsi;
    this.active = status.active;
    this.lastReadingAt = status.lastReading?.time.toISOString() ?? null;
    this.activeWindowMin = status.activeWindowMin;
    this.lastReading =
      status.lastReading === null
        ? null
        : new FuelReadingDto(status.lastReading);
  }
}
