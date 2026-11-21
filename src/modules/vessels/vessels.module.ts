import { Module } from '@nestjs/common';

import { VesselAccessService } from './vessel-access.service.js';
import { VesselsRepository } from './vessels.repository.js';

/** The FLEET projection and the tenancy rules built on it. */
@Module({
  providers: [VesselsRepository, VesselAccessService],
  exports: [VesselsRepository, VesselAccessService],
})
export class VesselsModule {}
