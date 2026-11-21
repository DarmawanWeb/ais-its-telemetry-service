import {
  CoreSubscriptionHandler,
  type Msg,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { DeviceIngestService } from '../modules/readings/device-ingest.service.js';

/**
 * MQTT device messages (contracts core subscription `telemetry-mqtt`,
 * subject `aisits.telemetry.*` of the NATS MQTT gateway, queue group
 * `telemetry` so that replicas share them). Outcomes are counted by
 * {@link DeviceIngestService}; the kit counts and logs handler failures.
 */
@Injectable()
export class DeviceMessagesConsumer {
  constructor(private readonly devices: DeviceIngestService) {}

  @CoreSubscriptionHandler({ subscription: 'telemetry-mqtt' })
  async onDeviceMessage(message: Msg): Promise<void> {
    await this.devices.handle(message.subject, message.data);
  }
}
