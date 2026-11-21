import { ApiProperty } from '@nestjs/swagger';

/** A vessel of the telemetry overview. */
export interface TelemetryVessel {
  readonly mmsi: number;
  readonly vesselId: string;
  readonly orgId: string | null;
  readonly name: string;
  readonly status: 'active' | 'inactive' | 'laid_up';
  readonly lastReadingAt: Date | null;
  readonly active: boolean;
  readonly devices: number;
}

/** An entry of `GET /telemetry/vessels`. */
export class TelemetryVesselDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({ format: 'uuid' })
  readonly vesselId: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly orgId: string | null;

  @ApiProperty({ example: 'KM Sinar Bangun' })
  readonly name: string;

  @ApiProperty({
    enum: ['active', 'inactive', 'laid_up'],
    description: 'Fleet status of the vessel',
  })
  readonly status: 'active' | 'inactive' | 'laid_up';

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly lastReadingAt: string | null;

  @ApiProperty({
    description:
      'Telemetry active (newest reading within TELEMETRY_ACTIVE_WINDOW_MIN)',
  })
  readonly active: boolean;

  @ApiProperty({ description: 'Registered devices on the vessel', example: 1 })
  readonly devices: number;

  constructor(vessel: TelemetryVessel) {
    this.mmsi = vessel.mmsi;
    this.vesselId = vessel.vesselId;
    this.orgId = vessel.orgId;
    this.name = vessel.name;
    this.status = vessel.status;
    this.lastReadingAt = vessel.lastReadingAt?.toISOString() ?? null;
    this.active = vessel.active;
    this.devices = vessel.devices;
  }
}
