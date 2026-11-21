import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import type { Config } from '../../config.js';
import { readingKey } from '../../domain/fuel-reading.js';
import { type StoredReading, toRecordedEvent } from './reading.js';
import { ReadingsRepository } from './readings.repository.js';

/** Publishes in flight at once (as the kit's `publishMany`). */
const PUBLISH_CONCURRENCY = 64;

/**
 * Publication of stored readings as `fuel.reading.recorded.v1` (stream
 * `FUEL`, subject `fuel.reading.v1.<mmsi>`), always **after** the readings
 * committed. `Nats-Msg-Id` is the natural key `<mmsi>:<time>`, so JetStream
 * drops a republication within its 2-minute window and consumers dedupe by
 * `(mmsi, time)` beyond it. A reading that cannot be published now keeps
 * `published_at = NULL` and stays queued for the {@link ReadingRelay}.
 */
@Injectable()
export class ReadingPublisher {
  private readonly logger = new Logger(ReadingPublisher.name);

  constructor(
    private readonly events: EventPublisher,
    private readonly nats: NatsClient,
    private readonly repository: ReadingsRepository,
    @InjectConfig() private readonly config: Config,
  ) {}

  /**
   * Publishes freshly committed readings and marks the published ones. Never
   * throws: what fails stays queued for the relay.
   *
   * @returns how many readings are in the stream now.
   */
  async publishCommitted(readings: readonly StoredReading[]): Promise<number> {
    if (readings.length === 0) return 0;
    const published = await this.send(readings);
    if (published.length === 0) return 0;
    try {
      await this.repository.markPublished(published);
    } catch (error) {
      // Published but not marked: the relay republishes them (deduplicated).
      this.logger.warn(
        { err: error, readings: published.length },
        'Could not mark published readings; the relay will republish them',
      );
    }
    return published.length;
  }

  /**
   * Publishes readings in rounds of {@link PUBLISH_CONCURRENCY} and stops
   * after the first round with a failure (the stream or NATS is likely
   * unavailable, the rest would fail too). Never throws.
   *
   * @returns the readings stored in the stream, in input order.
   */
  async send(readings: readonly StoredReading[]): Promise<StoredReading[]> {
    if (!this.nats.isConnected()) {
      this.logger.debug(
        `NATS disconnected: ${readings.length} reading(s) left to the relay`,
      );
      return [];
    }
    const published: StoredReading[] = [];
    for (let start = 0; start < readings.length; start += PUBLISH_CONCURRENCY) {
      const round = readings.slice(start, start + PUBLISH_CONCURRENCY);
      const results = await Promise.allSettled(
        round.map((reading) => this.publishOne(reading)),
      );
      const failure = results.find((result) => result.status === 'rejected');
      round.forEach((reading, index) => {
        if (results[index]?.status === 'fulfilled') published.push(reading);
      });
      if (failure !== undefined) {
        const error: unknown = failure.reason;
        this.logger.warn(
          { err: error, unpublished: readings.length - published.length },
          'Publishing fuel readings failed; the relay will retry',
        );
        break;
      }
    }
    return published;
  }

  private async publishOne(reading: StoredReading): Promise<void> {
    await this.events.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      toRecordedEvent(reading),
      {
        msgId: readingKey(reading),
        timeoutMs: this.config.TELEMETRY_PUBLISH_TIMEOUT_MS,
      },
    );
  }
}
