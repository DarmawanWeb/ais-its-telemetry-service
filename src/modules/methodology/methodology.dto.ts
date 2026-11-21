import type { LocalizedText } from '@darmawanweb/ais-its-contracts/domain';
import {
  METHOD_DOMAINS,
  METHOD_STATUSES,
  type MethodDomain,
  type MethodStatus,
  type Reference,
} from '@darmawanweb/ais-its-contracts/references';
import { ApiProperty } from '@nestjs/swagger';

import type {
  ImplementedMethod,
  MethodologyDescription,
} from './methodology.service.js';

/** A text in every supported locale. */
export class LocalizedTextDto {
  @ApiProperty({ description: 'Bahasa Indonesia' })
  readonly id: string;

  @ApiProperty({ description: 'English' })
  readonly en: string;

  constructor(text: LocalizedText) {
    this.id = text.id;
    this.en = text.en;
  }
}

/** A source of a method. */
export class MethodReferenceDto {
  @ApiProperty({ example: 'imo-mepc-352-78' })
  readonly id: string;

  @ApiProperty()
  readonly title: string;

  @ApiProperty({ type: String, nullable: true, format: 'uri' })
  readonly url: string | null;

  constructor(reference: Reference) {
    this.id = reference.id;
    this.title = reference.title;
    this.url = reference.url;
  }
}

/** A method implemented by the service, resolved against the catalog. */
export class MethodSummaryDto {
  @ApiProperty({ example: 'cii.attained' })
  readonly id: string;

  @ApiProperty({
    description:
      'Whether the catalog shipped with @darmawanweb/ais-its-contracts describes the method',
  })
  readonly catalogued: boolean;

  @ApiProperty({ enum: METHOD_DOMAINS, nullable: true })
  readonly domain: MethodDomain | null;

  @ApiProperty({ type: LocalizedTextDto, nullable: true })
  readonly name: LocalizedTextDto | null;

  @ApiProperty({ enum: METHOD_STATUSES, nullable: true })
  readonly status: MethodStatus | null;

  @ApiProperty({
    description:
      'Values come from the thesis without a verified external source',
  })
  readonly needsCitation: boolean;

  @ApiProperty({ type: [MethodReferenceDto] })
  readonly references: MethodReferenceDto[];

  constructor({ id, method, references }: ImplementedMethod) {
    this.id = id;
    this.catalogued = method !== undefined;
    this.domain = method?.domain ?? null;
    this.name = method === undefined ? null : new LocalizedTextDto(method.name);
    this.status = method?.status ?? null;
    this.needsCitation = method?.needsCitation ?? false;
    this.references = references.map(
      (reference) => new MethodReferenceDto(reference),
    );
  }
}

/** `GET /telemetry/methodology`. */
export class MethodologyDto {
  @ApiProperty({ example: 'telemetry' })
  readonly service: string;

  @ApiProperty({ type: [MethodSummaryDto] })
  readonly methods: MethodSummaryDto[];

  constructor(description: MethodologyDescription) {
    this.service = description.service;
    this.methods = description.methods.map(
      (method) => new MethodSummaryDto(method),
    );
  }
}
