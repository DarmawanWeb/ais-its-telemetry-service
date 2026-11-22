import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  USER_READING_SOURCES,
  type UserReadingSource,
} from '../../../domain/fuel-reading.js';
import type { IngestOutcome } from '../reading.js';

/** Query of `POST /telemetry/readings`. */
export class IngestReadingsQuery {
  @ApiPropertyOptional({
    enum: USER_READING_SOURCES,
    default: 'manual',
    description:
      'Signed-in users only: `manual` entries or an `import` of historical data. API keys are attributed automatically (`device` for the key of a registered http device, else `api`).',
  })
  @IsOptional()
  @IsIn(USER_READING_SOURCES)
  readonly source?: UserReadingSource;
}

/** `202` of `POST /telemetry/readings`. */
export class IngestResultDto implements IngestOutcome {
  @ApiProperty({ description: 'Readings in the request', example: 2 })
  readonly received: number;

  @ApiProperty({ description: 'Readings stored by this request', example: 1 })
  readonly accepted: number;

  @ApiProperty({
    description:
      'Exact repeats (same period, amounts and device) of stored readings or within the request (ignored, idempotent)',
    example: 1,
  })
  readonly duplicates: number;

  @ApiProperty({
    description:
      'Accepted readings already published to the FUEL stream; the others follow through the relay within TELEMETRY_RELAY_AFTER_S',
    example: 1,
  })
  readonly published: number;

  constructor(outcome: IngestOutcome) {
    this.received = outcome.received;
    this.accepted = outcome.accepted;
    this.duplicates = outcome.duplicates;
    this.published = outcome.published;
  }
}
