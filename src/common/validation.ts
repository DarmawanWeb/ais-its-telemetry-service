import { isIsoDateTime } from '@darmawanweb/ais-its-contracts/api';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { Injectable, type PipeTransform } from '@nestjs/common';
import {
  buildMessage,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

/** Smallest and largest MMSI (9 digits, spec §5). */
export const MMSI_MIN = 100_000_000;
export const MMSI_MAX = 999_999_999;

/**
 * Validates a wire timestamp: ISO-8601 in UTC with a `Z` suffix (spec §2),
 * calendar-checked (contracts `isIsoDateTime`), e.g. `2026-11-21T10:00:00Z`.
 */
export function IsUtcDateTime(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isUtcDateTime',
      validator: {
        validate: (value: unknown) => isIsoDateTime(value),
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property must be an ISO-8601 UTC timestamp such as 2026-11-21T10:00:00Z`,
          options,
        ),
      },
    },
    options,
  );
}

/** Parses the `:mmsi` route parameter: 9 digits, else `400 VALIDATION_FAILED`. */
@Injectable()
export class ParseMmsiPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const mmsi = /^\d{9}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isInteger(mmsi) || mmsi < MMSI_MIN || mmsi > MMSI_MAX) {
      throw new ValidationFailedError([
        {
          field: 'mmsi',
          message: 'mmsi must be a 9-digit MMSI',
          code: 'isMmsi',
        },
      ]);
    }
    return mmsi;
  }
}
