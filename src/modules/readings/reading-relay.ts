import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import { ReadingPublisher } from './reading-publisher.js';
import {
  ReadingsRepository,
  type RelayBatchResult,
} from './readings.repository.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

/** Most relay transactions in one tick (a large backlog drains over several ticks). */
const MAX_BATCHES_PER_TICK = 20;

/** Result of one {@link ReadingRelay.relayOnce} call. */
export interface RelayResult extends RelayBatchResult {
  /** `true` when NATS was disconnected and nothing was tried. */
  readonly skipped: boolean;
}

/**
 * Publication relay: every `TELEMETRY_RELAY_INTERVAL_MS` it republishes the
 * readings still unpublished `TELEMETRY_RELAY_AFTER_S` seconds after they
 * were stored (NATS was down, the process died between commit and publish,
 * a publish timed out), so that no stored reading misses the FUEL stream.
 * Replicas share the backlog through `FOR UPDATE SKIP LOCKED`; the grace
 * period keeps the relay away from readings the request path is publishing.
 */
@Injectable()
export class ReadingRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReadingRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private tickInFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: ReadingsRepository,
    private readonly publisher: ReadingPublisher,
    private readonly nats: NatsClient,
    private readonly metrics: TelemetryMetrics,
    @InjectConfig() private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.TELEMETRY_RELAY_INTERVAL_MS === 0) {
      this.logger.warn(
        'Publication relay disabled (TELEMETRY_RELAY_INTERVAL_MS=0)',
      );
      return;
    }
    this.schedule();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.tickInFlight;
  }

  /** One relay transaction (at most `TELEMETRY_RELAY_BATCH_SIZE` readings). */
  async relayOnce(): Promise<RelayResult> {
    if (!this.nats.isConnected()) {
      return { claimed: 0, published: 0, orphaned: 0, skipped: true };
    }
    const result = await this.repository.relayBatch(
      {
        olderThanS: this.config.TELEMETRY_RELAY_AFTER_S,
        limit: this.config.TELEMETRY_RELAY_BATCH_SIZE,
      },
      (readings) => this.publisher.send(readings),
    );
    const failed = result.claimed - result.orphaned - result.published;
    this.metrics.relayed.inc({ outcome: 'published' }, result.published);
    this.metrics.relayed.inc({ outcome: 'failed' }, failed);
    this.metrics.relayed.inc({ outcome: 'orphaned' }, result.orphaned);
    if (result.published > 0) {
      this.logger.log(
        `Relayed ${result.published} unpublished fuel reading(s) to FUEL`,
      );
    }
    return { ...result, skipped: false };
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.tickInFlight = this.tick().finally(() => {
        this.tickInFlight = undefined;
        if (!this.stopped) this.schedule();
      });
    }, this.config.TELEMETRY_RELAY_INTERVAL_MS);
    this.timer.unref();
  }

  /** Drains full batches (bounded), then refreshes the backlog gauges. Never throws. */
  private async tick(): Promise<void> {
    try {
      for (
        let batch = 0;
        batch < MAX_BATCHES_PER_TICK && !this.stopped;
        batch += 1
      ) {
        const result = await this.relayOnce();
        const full = result.claimed === this.config.TELEMETRY_RELAY_BATCH_SIZE;
        if (
          result.skipped ||
          !full ||
          result.published < result.claimed - result.orphaned
        )
          break;
      }
      const backlog = await this.repository.backlog();
      this.metrics.unpublished.set(backlog.pending);
      this.metrics.oldestUnpublished.set(backlog.oldestAgeSeconds);
    } catch (error) {
      this.logger.warn({ err: error }, 'Publication relay tick failed');
    }
  }
}
