import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';
import type { Counter, Gauge, Histogram } from 'prom-client';

/** Upper bounds of the reading lag histogram, s (1 s … 1 day: devices may store and forward). */
const LAG_BUCKETS_SECONDS = [1, 5, 15, 60, 300, 900, 3600, 21_600, 86_400];

/**
 * Domain metrics of the service (spec §10, prefix `aisits_`):
 * - `aisits_telemetry_readings_total{source,outcome}` — `accepted`, `duplicate`,
 *   `conflict` (a different reading is stored at that vessel and time), `rejected` (MQTT);
 * - `aisits_telemetry_device_messages_total{outcome}` — MQTT device messages
 *   (`accepted`, `duplicate`, `conflict`, `invalid_subject`, `invalid_json`, `invalid_payload`,
 *   `unknown_device`, `inactive_device`, `transport_mismatch`, `vessel_not_found`,
 *   `vessel_mismatch`, `error`);
 * - `aisits_telemetry_reading_lag_seconds{source}` — storage time minus reading time;
 * - `aisits_telemetry_relayed_total{outcome}` — relay republications (`published`, `failed`, `orphaned`);
 * - `aisits_telemetry_unpublished_readings` / `aisits_telemetry_oldest_unpublished_seconds` — relay backlog.
 */
@Injectable()
export class TelemetryMetrics {
  readonly readings: Counter<'source' | 'outcome'>;
  readonly deviceMessages: Counter<'outcome'>;
  readonly lag: Histogram<'source'>;
  readonly relayed: Counter<'outcome'>;
  readonly unpublished: Gauge;
  readonly oldestUnpublished: Gauge;

  constructor(metrics: MetricsService) {
    this.readings = metrics.counter({
      name: 'telemetry_readings_total',
      help: 'Fuel readings received, by source and outcome',
      labelNames: ['source', 'outcome'],
    });
    this.deviceMessages = metrics.counter({
      name: 'telemetry_device_messages_total',
      help: 'MQTT device messages, by outcome',
      labelNames: ['outcome'],
    });
    this.lag = metrics.histogram({
      name: 'telemetry_reading_lag_seconds',
      help: 'Seconds between the time of a reading and its storage',
      labelNames: ['source'],
      buckets: LAG_BUCKETS_SECONDS,
    });
    this.relayed = metrics.counter({
      name: 'telemetry_relayed_total',
      help: 'Readings handled by the publication relay, by outcome',
      labelNames: ['outcome'],
    });
    this.unpublished = metrics.gauge({
      name: 'telemetry_unpublished_readings',
      help: 'Stored readings not yet in the FUEL stream',
    });
    this.oldestUnpublished = metrics.gauge({
      name: 'telemetry_oldest_unpublished_seconds',
      help: 'Age of the oldest reading not yet in the FUEL stream, s (0 when none)',
    });
  }
}
