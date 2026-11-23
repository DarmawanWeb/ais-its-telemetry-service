import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { ConsumersModule } from './consumers/consumers.module.js';
import * as schema from './db/schema.js';
import { DevicesModule } from './modules/devices/devices.module.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { ReadingsModule } from './modules/readings/readings.module.js';
import { MIGRATIONS_DIR } from './service.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens; the consumers,
 * the MQTT subscription and the publication relay start on bootstrap.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot
    // from this package's migrations/ (not the working directory).
    DatabaseModule.forRoot({ schema, migrationsDir: MIGRATIONS_DIR }),
    // This service produces the FUEL stream (created / widened at boot); the
    // AUDIT stream is ensured by AuditModule, FLEET by its consumer.
    NatsModule.forRoot({ streams: ['FUEL'] }),
    // Global default-deny guard: every route needs a principal unless @Public();
    // API keys only on @AllowApiKey routes (POST /telemetry/readings).
    AuthModule.forRoot(),
    // audit.recorded.v1 for device changes and manual readings (global).
    AuditModule,
    MethodologyModule,
    DevicesModule,
    ReadingsModule,
    ConsumersModule,
  ],
})
export class AppModule {}
