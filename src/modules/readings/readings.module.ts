import { Module } from '@nestjs/common';

import { CLOCK, SYSTEM_CLOCK } from '../../common/clock.js';
import { DevicesModule } from '../devices/devices.module.js';
import { VesselsModule } from '../vessels/vessels.module.js';
import { DeviceIngestService } from './device-ingest.service.js';
import { ReadingIngestService } from './reading-ingest.service.js';
import { ReadingPublisher } from './reading-publisher.js';
import { ReadingRelay } from './reading-relay.js';
import { ReadingsController } from './readings.controller.js';
import { ReadingsRepository } from './readings.repository.js';
import { ReadingsService } from './readings.service.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

/**
 * Fuel readings: REST ingestion and queries, the shared ingestion pipeline
 * (also used for MQTT device messages), post-commit publication of
 * `fuel.reading.recorded.v1` and its relay.
 */
@Module({
  imports: [VesselsModule, DevicesModule],
  controllers: [ReadingsController],
  providers: [
    ReadingsService,
    ReadingsRepository,
    ReadingIngestService,
    DeviceIngestService,
    ReadingPublisher,
    ReadingRelay,
    TelemetryMetrics,
    { provide: CLOCK, useValue: SYSTEM_CLOCK },
  ],
  exports: [DeviceIngestService, ReadingRelay],
})
export class ReadingsModule {}
