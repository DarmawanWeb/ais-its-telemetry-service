import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';

import type {
  FuelReadingInput,
  FuelReadingSource,
} from '../../domain/fuel-reading.js';

/** A reading to store: a validated input with its provenance. */
export interface NewReading extends FuelReadingInput {
  readonly source: FuelReadingSource;
  readonly deviceId: string | null;
}

/** A stored reading (`fuel_readings`). */
export interface StoredReading extends NewReading {
  /** When the service stored it. */
  readonly receivedAt: Date;
}

/** A batch for the ingestion pipeline: validated, authorized, one provenance. */
export interface IngestBatch {
  readonly readings: readonly FuelReadingInput[];
  readonly source: FuelReadingSource;
  readonly deviceId: string | null;
}

/**
 * What happens to readings whose `(mmsi, time)` holds a different reading
 * already: `reject` refuses the batch (REST answers `409 READING_CONFLICT`,
 * the client can correct and resend), `skip` stores the rest of it (MQTT:
 * fire and forget, rejecting would drop the device's other readings).
 */
export type ConflictPolicy = 'reject' | 'skip';

/** What storing a batch did (before publication). */
export interface StoreOutcome {
  readonly received: number;
  /** Readings stored by this batch. */
  readonly stored: readonly StoredReading[];
  /** Readings repeated in the batch or stored already with the same values and device. */
  readonly duplicates: number;
  /** Readings not stored: their key holds a different reading (values or device). */
  readonly conflicts: readonly NewReading[];
  /** Policy `reject` found conflicts: the batch was refused. */
  readonly rejected: boolean;
}

/** What happened to a batch. */
export interface IngestOutcome {
  readonly received: number;
  /** Newly stored readings. */
  readonly accepted: number;
  /** Readings repeated in the batch or stored already with the same values and device. */
  readonly duplicates: number;
  /** Accepted readings already stored in the FUEL stream; the rest is relayed. */
  readonly published: number;
}

/** The `fuel.reading.recorded.v1` payload of a stored reading. */
export function toRecordedEvent(reading: StoredReading): FuelReadingRecordedV1 {
  return {
    mmsi: reading.mmsi,
    time: reading.time.toISOString(),
    periodStart: reading.periodStart?.toISOString() ?? null,
    fuelMeTon: reading.fuelMeTon,
    fuelAeTon: reading.fuelAeTon,
    deviceId: reading.deviceId,
    source: reading.source,
  };
}
