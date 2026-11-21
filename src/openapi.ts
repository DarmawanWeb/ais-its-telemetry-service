import 'reflect-metadata';

import { exportOpenApi } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

// `pnpm openapi`: writes openapi.json from the real AppModule; `--check` (CI,
// `pnpm openapi:check`) fails when the committed file is stale. No lifecycle hook
// runs, so no connection is opened; the configuration comes from the schema
// defaults only (`env: {}`, placeholders for required runtime-only variables),
// which keeps the document reproducible.
await exportOpenApi({
  appModule: AppModule,
  configSchema,
  env: {},
  openapi: OPENAPI,
  check: process.argv.includes('--check'),
});
