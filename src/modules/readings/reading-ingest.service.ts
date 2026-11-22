import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../common/clock.js';
import {
  compareWithStored,
  dedupeReadings,
  type FuelReadingSource,
  groupByStorageWindow,
} from '../../domain/fuel-reading.js';
import type {
  ConflictPolicy,
  IngestBatch,
  IngestOutcome,
  NewReading,
  StoredReading,
  StoreOutcome,
} from './reading.js';
import { ReadingPublisher } from './reading-publisher.js';
import { ReadingsRepository, type StoreResult } from './readings.repository.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

/**
 * The ingestion pipeline shared by REST and MQTT, for batches that are
 * already validated and authorized: drop exact repeats, store each storage
 * window (UTC day) in its own transaction — duplicates of stored readings
 * are skipped, conflicting readings are never stored — then publish after
 * the commit. Counts every reading by source and outcome.
 */
@Injectable()
export class ReadingIngestService {
  constructor(
    private readonly repository: ReadingsRepository,
    private readonly publisher: ReadingPublisher,
    private readonly metrics: TelemetryMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Stores a batch ({@link store}) and publishes what was stored (MQTT path). */
  async ingest(
    batch: IngestBatch,
    policy: ConflictPolicy,
  ): Promise<IngestOutcome & { readonly conflicts: number }> {
    const outcome = await this.store(batch, policy);
    return {
      received: outcome.received,
      accepted: outcome.stored.length,
      duplicates: outcome.duplicates,
      conflicts: outcome.conflicts.length,
      published: await this.publish(outcome.stored),
    };
  }

  /**
   * Stores a batch window by window, in chronological order.
   *
   * - `skip`: conflicting readings are left out, the rest is stored.
   * - `reject`: all or nothing. A batch spanning several windows is first
   *   compared with the stored readings, so that a conflict rejects it before
   *   anything is written; each window still rolls back on a conflict found
   *   inside its transaction. Only a conflicting reading written concurrently
   *   between the comparison and a later window can leave the earlier windows
   *   stored (they are published by the relay; resending the batch without
   *   the conflicting readings is safe: stored readings count as duplicates).
   */
  async store(
    batch: IngestBatch,
    policy: ConflictPolicy,
  ): Promise<StoreOutcome> {
    const { unique, duplicates: repeated } = dedupeReadings(batch.readings);
    const readings: NewReading[] = unique.map((reading) => ({
      ...reading,
      source: batch.source,
      deviceId: batch.deviceId,
    }));
    const windows = groupByStorageWindow(readings);
    const outcome = {
      received: batch.readings.length,
      stored: [] as StoredReading[],
      duplicates: repeated,
      conflicts: [] as NewReading[],
    };
    this.metrics.readings.inc(
      { source: batch.source, outcome: 'duplicate' },
      repeated,
    );

    if (policy === 'reject' && windows.length > 1) {
      const { conflicts } = compareWithStored(
        readings,
        await this.repository.findStored(readings),
      );
      if (conflicts.length > 0) {
        this.count(batch.source, { conflicts });
        return { ...outcome, conflicts, rejected: true };
      }
    }

    for (const window of windows) {
      const result = await this.repository.store(window, {
        rejectConflicts: policy === 'reject',
      });
      this.count(batch.source, result);
      outcome.stored.push(...result.stored);
      outcome.duplicates += result.duplicates.length;
      outcome.conflicts.push(...result.conflicts);
      if (result.rejected) return { ...outcome, rejected: true };
    }
    return { ...outcome, rejected: false };
  }

  /**
   * Publishes freshly committed readings. Never throws: what fails stays
   * queued for the relay.
   *
   * @returns how many readings are in the FUEL stream now.
   */
  async publish(stored: readonly StoredReading[]): Promise<number> {
    return this.publisher.publishCommitted(stored);
  }

  /** Counts the readings of one window by outcome and the lag of the stored ones. */
  private count(
    source: FuelReadingSource,
    result: Partial<Pick<StoreResult, 'stored' | 'duplicates' | 'conflicts'>>,
  ): void {
    const stored = result.stored ?? [];
    this.metrics.readings.inc({ source, outcome: 'accepted' }, stored.length);
    this.metrics.readings.inc(
      { source, outcome: 'duplicate' },
      result.duplicates?.length ?? 0,
    );
    this.metrics.readings.inc(
      { source, outcome: 'conflict' },
      result.conflicts?.length ?? 0,
    );
    const now = this.clock.now().getTime();
    for (const reading of stored) {
      this.metrics.lag.observe(
        { source },
        Math.max(0, (now - reading.time.getTime()) / 1000),
      );
    }
  }
}
