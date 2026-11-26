import {
  type AppConfig,
  defineConfig,
  envInteger,
  envUrl,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import type { ReadingLimits } from './domain/fuel-reading.js';
import { MQTT_AUTHENTICATIONS } from './modules/devices/device-connection.js';
import { SERVICE } from './service.js';

/** A positive decimal number of tonnes from the environment. */
function envTonnes(maximum: number) {
  return z.coerce.number().positive().max(maximum);
}

/**
 * The MQTT broker URL of the development stack (`infra/compose`: the NATS
 * MQTT gateway on 1883, no TLS, no authentication).
 */
export const DEV_MQTT_URL = 'mqtt://localhost:1883';

/*
 * The refinements below also run when `envUrl` refused the value (Zod runs a
 * refinement after a failed check): a value that is no URL passes them, so
 * the report shows `Invalid URL` (with every other invalid variable) instead
 * of `new URL` throwing out of the validation.
 */

/**
 * Whether a URL is `scheme://host[:port]` only: a host, no port 0 (devices
 * cannot connect to it), no credentials, path, query or fragment.
 */
function isBareServerUrl(value: string): boolean {
  if (!URL.canParse(value)) return true;
  const url = new URL(value);
  return (
    url.hostname !== '' &&
    url.port !== '0' &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '' || url.pathname === '/') &&
    url.search === '' &&
    url.hash === ''
  );
}

/**
 * Whether the host of a URL is ASCII: a DNS name (letters, digits, `-`, `_`
 * and dots), an IPv4 address or an IPv6 address in brackets. `mqtt:` is no
 * special scheme of the URL standard, so its host gets no IDNA processing: a
 * non-ASCII name stays percent-encoded (`b%C3%BCcher.example`), which no
 * device resolves; internationalized names are given in punycode.
 */
function hasAsciiHost(value: string): boolean {
  if (!URL.canParse(value)) return true;
  const { hostname } = new URL(value);
  return (
    hostname === '' ||
    (hostname.startsWith('[') && hostname.endsWith(']')) ||
    /^[A-Za-z0-9._-]+$/.test(hostname)
  );
}

/** `mqtt://host[:port]` (plain) or `mqtts://host[:port]` (TLS). */
const MqttBrokerUrlSchema = envUrl(['mqtt', 'mqtts'])
  .refine(isBareServerUrl, {
    message:
      'Expected mqtt://host[:port] or mqtts://host[:port] (port 1–65535), without credentials, path, query or fragment',
  })
  .refine(hasAsciiHost, {
    message:
      'Expected an ASCII host (a DNS name, an IPv4 address or an [IPv6] address); give an internationalized domain name in punycode (xn--…)',
  });

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
  /**
   * A device whose newest reading is older than this many minutes is
   * `offline`, `idle` between `TELEMETRY_ACTIVE_WINDOW_MIN` and this
   * (`connectionState` of `GET /telemetry/devices`); at least the active
   * window, at most a year.
   */
  // v2 design default (24 h, the threshold the web console applied client-side); no external source.
  TELEMETRY_DEVICE_OFFLINE_AFTER_MIN: envInteger(1, 525_600).default(1440),
  /**
   * The platform's MQTT broker as devices reach it (the NATS MQTT gateway,
   * spec §3, §13.4), `mqtt://host[:port]` (default port 1883) or
   * `mqtts://host[:port]` (TLS, default port 8883). Only described to
   * administrators (`GET /telemetry/devices/:id/connection`): the service
   * receives device messages over `NATS_URL` and never connects to it. The
   * host is ASCII (an internationalized domain name in punycode, `xn--…`).
   */
  TELEMETRY_MQTT_URL: MqttBrokerUrlSchema.default(DEV_MQTT_URL),
  /**
   * How the broker authenticates devices: `none` (any client may publish, the
   * development broker) or `password` (one broker user per device, named by
   * its id and allowed to publish to its own topic only, provisioned by the
   * platform operator, `infra/nats/nats.conf`). Default: `password` in
   * production, `none` otherwise.
   */
  TELEMETRY_MQTT_AUTH: z.enum(MQTT_AUTHENTICATIONS).optional(),
  /** Readings may be at most this many minutes ahead of the server clock (spec §13.4). */
  TELEMETRY_MAX_FUTURE_SKEW_MIN: envInteger(0, 60).default(5),
  /** Readings may be at most this many days old (≤ the 5-year retention of `fuel_readings`). */
  TELEMETRY_MAX_AGE_DAYS: envInteger(1, 1825).default(1825),
  /** Largest main-engine fuel of one reading, t (v2 design default, ~1.5 × a day of the largest 2-stroke engines). */
  TELEMETRY_MAX_FUEL_ME_TON: envTonnes(100_000).default(500),
  /** Largest auxiliary-engine fuel of one reading, t (v2 design default). */
  TELEMETRY_MAX_FUEL_AE_TON: envTonnes(100_000).default(100),
  /** Longest measured period (`time − periodStart`) of one reading, hours. */
  TELEMETRY_MAX_PERIOD_H: envInteger(1, 744).default(24),
  /**
   * JetStream ack timeout of one `fuel.reading.recorded.v1` publish, ms; also
   * the longest wait for the audit records of user entries (published
   * concurrently), so a request waits at most this long after the commit.
   */
  TELEMETRY_PUBLISH_TIMEOUT_MS: envInteger(100, 60_000).default(5000),
  /** Poll interval of the publication relay, ms (`0` disables the relay). */
  TELEMETRY_RELAY_INTERVAL_MS: envInteger(0, 600_000).default(5000),
  /** The relay republishes readings still unpublished this many seconds after they were stored. */
  TELEMETRY_RELAY_AFTER_S: envInteger(1, 86_400).default(30),
  /** Readings the relay republishes per transaction. */
  TELEMETRY_RELAY_BATCH_SIZE: envInteger(1, 5000).default(500),
}).superRefine((env, ctx) => {
  if (
    env.TELEMETRY_DEVICE_OFFLINE_AFTER_MIN < env.TELEMETRY_ACTIVE_WINDOW_MIN
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['TELEMETRY_DEVICE_OFFLINE_AFTER_MIN'],
      message: `Must be at least TELEMETRY_ACTIVE_WINDOW_MIN (${env.TELEMETRY_ACTIVE_WINDOW_MIN})`,
    });
  }
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;

/** The plausibility limits of readings (spec §13.4) from the configuration. */
export function readingLimitsOf(config: Config): ReadingLimits {
  return {
    maxFuelMeTon: config.TELEMETRY_MAX_FUEL_ME_TON,
    maxFuelAeTon: config.TELEMETRY_MAX_FUEL_AE_TON,
    maxFutureSkewMs: config.TELEMETRY_MAX_FUTURE_SKEW_MIN * 60_000,
    maxAgeMs: config.TELEMETRY_MAX_AGE_DAYS * 86_400_000,
    maxPeriodMs: config.TELEMETRY_MAX_PERIOD_H * 3_600_000,
  };
}
