import type { FieldError } from '@darmawanweb/ais-its-contracts/api';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { validationErrorsToFieldErrors } from '@darmawanweb/ais-its-nest/http';
import { Injectable, type PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_READINGS_PER_BATCH } from '../../../domain/fuel-reading.js';
import { FuelReadingInputDto } from './fuel-reading-input.dto.js';

/**
 * Body of `POST /telemetry/readings`: one reading object or an array of
 * 1–{@link MAX_READINGS_PER_BATCH} readings, each validated like a DTO of
 * the global pipe (unknown properties rejected). Field paths are
 * `<index>.<field>` — index `0` for a single object — and match the paths of
 * the plausibility errors reported by the service.
 *
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with every problem.
 */
@Injectable()
export class ParseReadingsBodyPipe implements PipeTransform<
  unknown,
  Promise<FuelReadingInputDto[]>
> {
  async transform(body: unknown): Promise<FuelReadingInputDto[]> {
    const items: unknown[] = Array.isArray(body) ? body : [body];
    if (items.length === 0) {
      throw invalidBody(
        'arrayMinSize',
        'the body must contain at least one reading',
      );
    }
    if (items.length > MAX_READINGS_PER_BATCH) {
      throw invalidBody(
        'arrayMaxSize',
        `the body must contain at most ${MAX_READINGS_PER_BATCH} readings`,
      );
    }

    const errors: FieldError[] = [];
    const readings: FuelReadingInputDto[] = [];
    for (const [index, item] of items.entries()) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        errors.push({
          field: String(index),
          message: 'a reading must be an object',
          code: 'isObject',
        });
        continue;
      }
      const reading = plainToInstance(FuelReadingInputDto, item);
      const problems = await validate(reading, {
        whitelist: true,
        forbidNonWhitelisted: true,
        validationError: { target: false, value: false },
      });
      errors.push(...validationErrorsToFieldErrors(problems, String(index)));
      readings.push(reading);
    }
    if (errors.length > 0) throw new ValidationFailedError(errors);
    return readings;
  }
}

function invalidBody(code: string, message: string): ValidationFailedError {
  return new ValidationFailedError([{ field: 'body', message, code }]);
}
