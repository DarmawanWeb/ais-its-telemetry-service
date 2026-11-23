import { Module } from '@nestjs/common';

import { VesselsModule } from '../vessels/vessels.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesRepository } from './devices.repository.js';
import { DevicesService } from './devices.service.js';
import { VesselDevicesController } from './vessel-devices.controller.js';

/**
 * The device registry (`/telemetry/devices`), the read-only devices of a
 * vessel (`/telemetry/vessels/:mmsi/devices`) and the device lookups of the
 * ingestion paths.
 */
@Module({
  imports: [VesselsModule],
  controllers: [DevicesController, VesselDevicesController],
  providers: [DevicesService, DevicesRepository],
  exports: [DevicesService],
})
export class DevicesModule {}
