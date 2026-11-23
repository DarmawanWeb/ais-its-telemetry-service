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
    // The envelope is exactly the consumer's two fleet event types
    // (contracts 0.4 keeps literal consumer types), so the switch is exhaustive.
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED: {
        const outcome = await this.vessels.upsert(event.data);
        this.logger.debug(
          { vesselId: event.data.id, mmsi: event.data.mmsi, outcome },
          'vessel projected',
        );
        return;
      }
      case EVENT_TYPES.FLEET_VESSEL_DELETED: {
        const changed = await this.vessels.markDeleted(
          event.data,
          new Date(event.time),
        );
        this.logger.debug(
          { vesselId: event.data.id, mmsi: event.data.mmsi, changed },
          'vessel deleted',
        );
        return;
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }
}
