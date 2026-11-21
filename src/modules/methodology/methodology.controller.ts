import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MethodologyDto } from './methodology.dto.js';
import { MethodologyService } from './methodology.service.js';

@ApiTags('methodology')
@Controller('telemetry/methodology')
export class MethodologyController {
  constructor(private readonly methodology: MethodologyService) {}

  /** No permission decorator: any signed-in user (the global guard denies anonymous calls). */
  @Get()
  @ApiOperation({
    summary: 'Methods implemented by this service, with their sources',
  })
  @ApiOkResponse({ type: MethodologyDto })
  describe(): MethodologyDto {
    return new MethodologyDto(this.methodology.describe());
  }
}
