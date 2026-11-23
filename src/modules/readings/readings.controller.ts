import { Readable } from 'node:stream';

import type { CursorPage, Paginated } from '@darmawanweb/ais-its-contracts/api';
import {
  AllowApiKey,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  ApiCursorResponse,
  ApiPageResponse,
  MmsiParam,
  PageQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { MAX_READINGS_PER_BATCH } from '../../domain/fuel-reading.js';
import {
  FuelReadingInputDto,
  toFuelReadingInput,
} from './dto/fuel-reading-input.dto.js';
import { IngestReadingsQuery, IngestResultDto } from './dto/ingest.dto.js';
import { ParseReadingsBodyPipe } from './dto/parse-readings-body.pipe.js';
import {
  FuelSeriesPointDto,
  FuelSeriesQuery,
  FuelSeriesRangeQuery,
} from './dto/series.dto.js';
import { TelemetryStatusDto } from './dto/status.dto.js';
import { FuelSummaryDto } from './dto/summary.dto.js';
import { TelemetryVesselDto } from './dto/telemetry-vessel.dto.js';
import { ReadingsService } from './readings.service.js';
import {
  SERIES_CSV_HEADER,
  SERIES_CSV_MEDIA_TYPE,
  seriesCsv,
  seriesCsvFilename,
} from './series-csv.js';

/**
 * Fuel readings `/api/v2/telemetry` (spec §13.4): ingestion by API keys
 * (`telemetry:ingest`) and users (`telemetry:write`), queries (`telemetry:read`).
 * Telemetry is tenant-private: the vessel must belong to the caller's organization.
 */
@ApiTags('readings')
@ApiExtraModels(FuelReadingInputDto)
@Controller('telemetry')
export class ReadingsController {
  constructor(private readonly readings: ReadingsService) {}

  @Post('readings')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('telemetry:write')
  @AllowApiKey('telemetry:ingest')
  @ApiOperation({
    summary: 'Ingest fuel readings (one object or an array of ≤ 1000)',
    description:
      'All or nothing: every reading is validated (non-negative, ≤ configured maxima, time ≤ now + TELEMETRY_MAX_FUTURE_SKEW_MIN ' +
      'and at most TELEMETRY_MAX_AGE_DAYS old, periodStart before time) and every vessel must belong to the caller’s organization ' +
      'before anything is stored. ' +
      'A vessel has one reading per time: an exact repeat (same period, amounts and device) is an idempotent duplicate; ' +
      'a different reading at a stored (mmsi, time) — other values, or another device of the vessel — answers ' +
      '409 READING_CONFLICT and nothing of the request is stored. Stored readings are published as ' +
      'fuel.reading.recorded.v1 after the commit (Nats-Msg-Id <mmsi>:<time>). Error fields are `<index>.<field>`.',
  })
  @ApiBody({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(FuelReadingInputDto) },
        {
          type: 'array',
          minItems: 1,
          maxItems: MAX_READINGS_PER_BATCH,
          items: { $ref: getSchemaPath(FuelReadingInputDto) },
        },
      ],
    },
  })
  @ApiAcceptedResponse({ type: IngestResultDto })
  async ingest(
    @Body(ParseReadingsBodyPipe) body: FuelReadingInputDto[],
    @Query() query: IngestReadingsQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IngestResultDto> {
    const outcome = await this.readings.ingest(
      body.map(toFuelReadingInput),
      principal,
      query.source,
      request,
    );
    return new IngestResultDto(outcome);
  }

  @Get('vessels')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Vessels of the organization with their telemetry status',
    description:
      'Newest reading, active flag and number of devices per vessel, by MMSI.',
  })
  @ApiPageResponse(TelemetryVesselDto)
  async vessels(
    @Query() query: PageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Paginated<TelemetryVesselDto>> {
    const page = await this.readings.vesselOverview(
      { page: query.page, pageSize: query.pageSize },
      principal,
    );
    return {
      data: page.data.map((vessel) => new TelemetryVesselDto(vessel)),
      meta: page.meta,
    };
  }

  @Get('vessels/:mmsi/readings')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Readings of a vessel, raw or as hourly / daily sums',
    description:
      'Time-ordered cursor pages: ascending by default, `order=desc` newest first (the newest readings: ' +
      '`order=desc&limit=20`; `to` defaults to now, so pass a later `to` for readings up to ' +
      'TELEMETRY_MAX_FUTURE_SKEW_MIN ahead of the server clock). `[from, to)`; buckets whose start lies in the range. ' +
      'Hourly and daily sums come from the continuous aggregates: readings stored more than an hour after their time ' +
      '(store and forward, imports) are included after the next refresh (fuel_hourly every 15 min, fuel_daily hourly).',
  })
  @ApiCursorResponse(FuelSeriesPointDto)
  async series(
    @MmsiParam() mmsi: number,
    @Query() query: FuelSeriesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CursorPage<FuelSeriesPointDto>> {
    const page = await this.readings.series(mmsi, query, principal);
    return {
      data: page.data.map((point) => new FuelSeriesPointDto(point)),
      page: page.page,
    };
  }

  @Get('vessels/:mmsi/readings.csv')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Export the readings or hourly / daily sums of a vessel as CSV',
    description:
      'The series of GET …/readings (same `from`, `to` and `bucket`, defaults and range limits; ascending) as one ' +
      'streamed RFC 4180 file (`Content-Disposition: attachment`): the header line ' +
      '`time,periodStart,fuelMeTon,fuelAeTon,totalFuelTon,readings,source,deviceId`, CRLF line ends, the values of ' +
      'the JSON points (empty for null; periodStart, source and deviceId only for raw readings). Errors before the ' +
      'first byte are problem details; a failure during the transfer aborts the connection, so a cut file never ' +
      'looks complete.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: `CSV file with a header line (\`Content-Type: ${SERIES_CSV_MEDIA_TYPE}\`)`,
    content: {
      'text/csv': {
        schema: { type: 'string' },
        example: `${SERIES_CSV_HEADER}2026-11-21T10:15:00.000Z,,1.25,0.25,1.5,1,device,0192f3a4-5b6c-7d8e-9f01-23456789abcd\r\n`,
      },
    },
  })
  async exportCsv(
    @MmsiParam() mmsi: number,
    @Query() query: FuelSeriesRangeQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const exported = await this.readings.exportSeries(mmsi, query, principal);
    const filename = seriesCsvFilename(
      mmsi,
      exported.bucket,
      exported.from,
      exported.to,
    );
    return new StreamableFile(
      Readable.from(seriesCsv(exported.batches), { objectMode: false }),
      {
        type: SERIES_CSV_MEDIA_TYPE,
        disposition: `attachment; filename="${filename}"`,
      },
    );
  }

  @Get('vessels/:mmsi/summary')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Fuel totals of a vessel over a time range',
    description:
      'Readings with time in `[from, to)` (default: the last 30 days, at most 5 years): whole UTC days from fuel_daily, ' +
      'whole hours from fuel_hourly, the edges from the raw readings (late readings: see the readings endpoint).',
  })
  @ApiOkResponse({ type: FuelSummaryDto })
  async summary(
    @MmsiParam() mmsi: number,
    @Query() query: TimeRangeQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FuelSummaryDto> {
    return new FuelSummaryDto(
      await this.readings.summary(mmsi, query, principal),
    );
  }

  @Get('vessels/:mmsi/status')
  @RequirePermissions('telemetry:read')
  @ApiOperation({
    summary: 'Whether telemetry of a vessel is active, with its newest reading',
    description:
      'Active = newest reading at most TELEMETRY_ACTIVE_WINDOW_MIN minutes old.',
  })
  @ApiOkResponse({ type: TelemetryStatusDto })
  async status(
    @MmsiParam() mmsi: number,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TelemetryStatusDto> {
    return new TelemetryStatusDto(await this.readings.status(mmsi, principal));
  }
}
