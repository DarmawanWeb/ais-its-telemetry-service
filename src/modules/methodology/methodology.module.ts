import { APP_CONFIG, type BaseConfig } from '@darmawanweb/ais-its-nest';
import { Module } from '@nestjs/common';

import { IMPLEMENTED_METHOD_IDS } from './implemented-methods.js';
import { CONTRACTS_METHOD_CATALOG } from './method-catalog.js';
import { MethodologyController } from './methodology.controller.js';
import { MethodologyService } from './methodology.service.js';

/** `GET /api/v2/telemetry/methodology` (spec §17 traceability). */
@Module({
  controllers: [MethodologyController],
  providers: [
    {
      provide: MethodologyService,
      useFactory: (config: BaseConfig): MethodologyService =>
        new MethodologyService(
          config.SERVICE_NAME,
          IMPLEMENTED_METHOD_IDS,
          CONTRACTS_METHOD_CATALOG,
        ),
      inject: [APP_CONFIG],
    },
  ],
})
export class MethodologyModule {}
