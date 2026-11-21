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

/** What happened to a batch. */
export interface IngestOutcome {
  readonly received: number;
  /** Newly stored readings. */
  readonly accepted: number;
  /** Readings whose `(mmsi, time)` was stored already or repeated in the batch. */
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
