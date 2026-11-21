import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselsRepository } from '../modules/vessels/vessels.repository.js';

/**
 * FLEET projection (durable consumer `telemetry-fleet`, spec §7.3): keeps
 * `vessels` (MMSI → vessel, organization) current for the tenancy checks.
 * Idempotent by natural keys and versions: a snapshot applies only when
 * newer than the stored state, a deletion leaves a tombstone.
 */
@Injectable()
export class FleetConsumer {
  private readonly logger = new Logger(FleetConsumer.name);

  constructor(private readonly vessels: VesselsRepository) {}

  @EventHandler({ consumer: 'telemetry-fleet' })
  async onVessel(event: ConsumerEnvelope<'telemetry-fleet'>): Promise<void> {
    // The contracts declare the consumer with the widened
    // `DurableConsumerDefinition` type, so the envelope is the union of every
    // event; the kit only delivers the consumer's two fleet types here.
    if (event.type === EVENT_TYPES.FLEET_VESSEL_UPSERTED) {
      const outcome = await this.vessels.upsert(event.data);
      this.logger.debug(
        { vesselId: event.data.id, mmsi: event.data.mmsi, outcome },
        'vessel projected',
      );
    } else if (event.type === EVENT_TYPES.FLEET_VESSEL_DELETED) {
      const changed = await this.vessels.markDeleted(
        event.data,
        new Date(event.time),
      );
      this.logger.debug(
        { vesselId: event.data.id, mmsi: event.data.mmsi, changed },
        'vessel deleted',
      );
    }
  }
}
