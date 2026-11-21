import { existsSync } from 'node:fs';

import { startTelemetry } from '@darmawanweb/ais-its-nest/telemetry';

import { SERVICE } from './service.js';

// OpenTelemetry patches modules while they load, so it starts before the
// application is imported. OTEL_* may come from .env, which loadConfig() would
// otherwise read only later (variables already set win).
if (existsSync('.env')) process.loadEnvFile('.env');

await startTelemetry({
  serviceName: process.env.SERVICE_NAME ?? SERVICE.name,
  serviceVersion: process.env.SERVICE_VERSION ?? SERVICE.version,
});
await import('./server.js');
