import { runMigrationsCli } from '@darmawanweb/ais-its-nest/db';

import { configSchema } from './config.js';

// `pnpm migrate`: applies migrations/ to DATABASE_SCHEMA under an advisory lock
// (the same migrator runs at startup when DB_MIGRATE_ON_BOOT=true).
await runMigrationsCli({ configSchema });
