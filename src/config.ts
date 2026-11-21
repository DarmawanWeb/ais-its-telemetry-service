import {
  type AppConfig,
  defineConfig,
  envInteger,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import type { ReadingLimits } from './domain/fuel-reading.js';
import { SERVICE } from './service.js';

/** A positive decimal number of tonnes from the environment. */
function envTonnes(maximum: number) {
  return z.coerce.number().positive().max(maximum);
}

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables. Add a variable here and to
 * `.env.example`; `loadConfig()` refuses to start on invalid values and prints
 * every problem.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),

  /**
   * Telemetry of a vessel is "active" while its newest reading is at most
   * this many minutes old (spec §13.4, method `fuel.method_selection`).
   */
  // SOURCE: thesis — needs citation (v2 default of 10 min; the legacy window was 10 s by a unit bug).
  TELEMETRY_ACTIVE_WINDOW_MIN: envInteger(1, 1440).default(10),
  /** Readings may be at most this many minutes ahead of the server clock (spec §13.4). */
  TELEMETRY_MAX_FUTURE_SKEW_MIN: envInteger(0, 60).default(5),
  /** Largest main-engine fuel of one reading, t (v2 design default, ~1.5 × a day of the largest 2-stroke engines). */
  TELEMETRY_MAX_FUEL_ME_TON: envTonnes(100_000).default(500),
  /** Largest auxiliary-engine fuel of one reading, t (v2 design default). */
  TELEMETRY_MAX_FUEL_AE_TON: envTonnes(100_000).default(100),
  /** Longest measured period (`time − periodStart`) of one reading, hours. */
  TELEMETRY_MAX_PERIOD_H: envInteger(1, 744).default(24),
  /** JetStream ack timeout of one `fuel.reading.recorded.v1` publish, ms. */
  TELEMETRY_PUBLISH_TIMEOUT_MS: envInteger(100, 60_000).default(5000),
  /** Poll interval of the publication relay, ms (`0` disables the relay). */
  TELEMETRY_RELAY_INTERVAL_MS: envInteger(0, 600_000).default(5000),
  /** The relay republishes readings still unpublished this many seconds after they were stored. */
  TELEMETRY_RELAY_AFTER_S: envInteger(1, 86_400).default(30),
  /** Readings the relay republishes per transaction. */
  TELEMETRY_RELAY_BATCH_SIZE: envInteger(1, 5000).default(500),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;

/** The plausibility limits of readings (spec §13.4) from the configuration. */
export function readingLimitsOf(config: Config): ReadingLimits {
  return {
    maxFuelMeTon: config.TELEMETRY_MAX_FUEL_ME_TON,
    maxFuelAeTon: config.TELEMETRY_MAX_FUEL_AE_TON,
    maxFutureSkewMs: config.TELEMETRY_MAX_FUTURE_SKEW_MIN * 60_000,
    maxPeriodMs: config.TELEMETRY_MAX_PERIOD_H * 3_600_000,
  };
}
