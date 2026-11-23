import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  ApiPageResponse,
  MmsiParam,
  PageQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { DevicesService } from './devices.service.js';
import { VesselDeviceDto } from './dto/vessel-device.dto.js';

/**
 * Read-only devices of a vessel `/api/v2/telemetry/vessels/:mmsi/devices`
 * [`telemetry:read`]: fleet managers see which meters report for a vessel
 * of their organization; the registry itself stays `device:manage`.
 */
@ApiTags('devices')
@Controller('telemetry/vessels')
export class VesselDevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get(':mmsi/devices')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Devices of a vessel (read-only)',
    description:
      'The devices the vessel’s organization registered on it, by name: id, name, kind, status and lastSeenAt, ' +
      'never credentials. The vessel must belong to the caller’s organization (platform administrators: any); ' +
      'the devices are those counted by GET /telemetry/vessels.',
  })
  @ApiPageResponse(VesselDeviceDto)
  async list(
    @MmsiParam() mmsi: number,
    @Query() query: PageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Paginated<VesselDeviceDto>> {
    const page = await this.devices.listOfVessel(
      mmsi,
      { page: query.page, pageSize: query.pageSize },
      principal,
    );
    return {
      data: page.data.map((device) => new VesselDeviceDto(device)),
      meta: page.meta,
    };
  }
}
