import { Module } from '@nestjs/common';

import { VesselsModule } from '../vessels/vessels.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesRepository } from './devices.repository.js';
import { DevicesService } from './devices.service.js';

/** The device registry (`/telemetry/devices`) and device lookups of the ingestion paths. */
@Module({
  imports: [VesselsModule],
  controllers: [DevicesController],
  providers: [DevicesService, DevicesRepository],
  exports: [DevicesService],
})
export class DevicesModule {}
