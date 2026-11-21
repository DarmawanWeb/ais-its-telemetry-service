import { Module } from '@nestjs/common';

import { ReadingsModule } from '../modules/readings/readings.module.js';
import { VesselsModule } from '../modules/vessels/vessels.module.js';
import { DeviceMessagesConsumer } from './device-messages.consumer.js';
import { FleetConsumer } from './fleet.consumer.js';

/** NATS consumers: the FLEET projection and the MQTT device messages. */
@Module({
  imports: [VesselsModule, ReadingsModule],
  providers: [FleetConsumer, DeviceMessagesConsumer],
})
export class ConsumersModule {}
