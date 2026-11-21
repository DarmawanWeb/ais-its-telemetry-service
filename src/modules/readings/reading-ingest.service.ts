import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../common/clock.js';
import { dedupeReadings } from '../../domain/fuel-reading.js';
import type { IngestBatch, IngestOutcome } from './reading.js';
import { ReadingPublisher } from './reading-publisher.js';
import { ReadingsRepository } from './readings.repository.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

/**
 * The ingestion pipeline shared by REST and MQTT, for batches that are
 * already validated and authorized: drop repeated keys, store and queue in
 * one transaction (duplicates of stored readings are skipped), then publish
 * after the commit. Counts every reading by source and outcome.
 */
@Injectable()
export class ReadingIngestService {
  constructor(
    private readonly repository: ReadingsRepository,
    private readonly publisher: ReadingPublisher,
    private readonly metrics: TelemetryMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async ingest(batch: IngestBatch): Promise<IngestOutcome> {
    const { unique, duplicates: repeated } = dedupeReadings(batch.readings);
    const stored = await this.repository.insert(
      unique.map((reading) => ({
        ...reading,
        source: batch.source,
        deviceId: batch.deviceId,
      })),
    );
    const duplicates = repeated + unique.length - stored.length;

    this.metrics.readings.inc(
      { source: batch.source, outcome: 'accepted' },
      stored.length,
    );
    this.metrics.readings.inc(
      { source: batch.source, outcome: 'duplicate' },
      duplicates,
    );
    const now = this.clock.now().getTime();
    for (const reading of stored) {
      this.metrics.lag.observe(
        { source: batch.source },
        Math.max(0, (now - reading.time.getTime()) / 1000),
      );
    }

    const published = await this.publisher.publishCommitted(stored);
    return {
      received: batch.readings.length,
      accepted: stored.length,
      duplicates,
      published,
    };
  }
}
