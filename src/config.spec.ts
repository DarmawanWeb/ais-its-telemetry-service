import { ConfigValidationError, loadConfig } from '@darmawanweb/ais-its-nest';
import { describe, expect, it } from 'vitest';

import { configSchema, readingLimitsOf } from './config.js';
import { SERVICE } from './service.js';

/** Loads the configuration from `env` only (no .env file, no process.env). */
function load(env: Record<string, string> = {}) {
  return loadConfig(configSchema, {
    env: { LOG_LEVEL: 'silent', ...env },
    envFile: false,
    output: null,
  });
}

describe('configSchema', () => {
  it('applies the service defaults (spec §3, §4, §6)', () => {
    const config = load();

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      SERVICE_NAME: SERVICE.name,
      SERVICE_VERSION: SERVICE.version,
      PORT: SERVICE.port,
      DATABASE_SCHEMA: SERVICE.schema,
      DATABASE_URL: `postgres://${SERVICE.schema}_svc:${SERVICE.schema}_svc@localhost:5432/aisits`,
      NATS_URL: ['nats://localhost:4222'],
    });
  });

  it('applies the telemetry defaults (spec §13.4)', () => {
    const config = load();

    expect(config).toMatchObject({
      TELEMETRY_ACTIVE_WINDOW_MIN: 10,
      TELEMETRY_MAX_FUTURE_SKEW_MIN: 5,
      TELEMETRY_MAX_AGE_DAYS: 1825,
      TELEMETRY_MAX_FUEL_ME_TON: 500,
      TELEMETRY_MAX_FUEL_AE_TON: 100,
      TELEMETRY_MAX_PERIOD_H: 24,
      TELEMETRY_RELAY_INTERVAL_MS: 5000,
      TELEMETRY_RELAY_AFTER_S: 30,
    });
    expect(readingLimitsOf(config)).toEqual({
      maxFuelMeTon: 500,
      maxFuelAeTon: 100,
      maxFutureSkewMs: 300_000,
      maxAgeMs: 1825 * 86_400_000,
      maxPeriodMs: 86_400_000,
    });
  });

  it('reads decimal fuel maxima and refuses non-positive ones', () => {
    expect(
      load({ TELEMETRY_MAX_FUEL_AE_TON: '12.5' }).TELEMETRY_MAX_FUEL_AE_TON,
    ).toBe(12.5);
    expect(() => load({ TELEMETRY_MAX_FUEL_ME_TON: '0' })).toThrow(
      ConfigValidationError,
    );
    expect(() => load({ TELEMETRY_RELAY_AFTER_S: '0' })).toThrow(
      ConfigValidationError,
    );
  });

  it('keeps the accepted reading age within the 5-year retention', () => {
    expect(load({ TELEMETRY_MAX_AGE_DAYS: '30' }).TELEMETRY_MAX_AGE_DAYS).toBe(
      30,
    );
    expect(() => load({ TELEMETRY_MAX_AGE_DAYS: '1826' })).toThrow(
      ConfigValidationError,
    );
  });

  it('reads overrides from the environment', () => {
    expect(
      load({ PORT: '4000', NATS_URL: 'nats://a:4222,nats://b:4222' }),
    ).toMatchObject({
      PORT: 4000,
      NATS_URL: ['nats://a:4222', 'nats://b:4222'],
    });
  });

  it('refuses invalid values', () => {
    expect(() => load({ PORT: 'eighty' })).toThrow(ConfigValidationError);
  });

  it('refuses the development secrets in production', () => {
    expect(() =>
      load({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@db:5432/aisits',
      }),
    ).toThrow(ConfigValidationError);
  });
});
