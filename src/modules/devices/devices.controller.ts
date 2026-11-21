import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { ApiPageResponse } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { DevicesService } from './devices.service.js';
import { CreateDeviceDto } from './dto/create-device.dto.js';
import { DeviceDto } from './dto/device.dto.js';
import { ListDevicesQuery } from './dto/list-devices.query.js';
import { UpdateDeviceDto } from './dto/update-device.dto.js';

/**
 * Device registry `/api/v2/telemetry/devices` [`device:manage`]: devices
 * belong to the organization of their vessel (spec §8.5).
 */
@ApiTags('devices')
@Controller('telemetry/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @RequirePermissions('device:manage')
  @ApiOperation({
    summary: 'Register a device on a vessel of the organization',
  })
  @ApiCreatedResponse({ type: DeviceDto })
  async create(
    @Body() body: CreateDeviceDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DeviceDto> {
    return new DeviceDto(await this.devices.create(body, principal, request));
  }

  @Get()
  @RequirePermissions('device:manage')
  @ApiOperation({ summary: 'List devices by vessel and name' })
  @ApiPageResponse(DeviceDto)
  async list(
    @Query() query: ListDevicesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Paginated<DeviceDto>> {
    const { page, pageSize, ...filter } = query;
    const result = await this.devices.list(
      filter,
      { page, pageSize },
      principal,
    );
    return {
      data: result.data.map((device) => new DeviceDto(device)),
      meta: result.meta,
    };
  }

  @Get(':id')
  @RequirePermissions('device:manage')
  @ApiOperation({ summary: 'Get a device' })
  @ApiOkResponse({ type: DeviceDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeviceDto> {
    return new DeviceDto(await this.devices.get(id, principal));
  }

  @Patch(':id')
  @RequirePermissions('device:manage')
  @ApiOperation({
    summary: 'Rename, (de)activate, move or re-key a device',
    description:
      'Inactive devices are rejected on every ingestion path. http devices need an apiKeyId, mqtt devices none.',
  })
  @ApiOkResponse({ type: DeviceDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDeviceDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DeviceDto> {
    return new DeviceDto(
      await this.devices.update(id, body, principal, request),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('device:manage')
  @ApiOperation({ summary: 'Delete a device (its readings are kept)' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.devices.remove(id, principal, request);
  }
}
