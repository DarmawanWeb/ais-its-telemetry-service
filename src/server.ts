import 'reflect-metadata';

import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

// Connect, migrate and ensure streams (onModuleInit) → restore state and start
// consumers (onApplicationBootstrap) → listen on HOST:PORT. SIGTERM turns
// readiness to 503, drains consumers and NATS, then closes the pool.
await bootstrapService({
  appModule: AppModule,
  config: loadConfig(configSchema),
  openapi: OPENAPI,
});
