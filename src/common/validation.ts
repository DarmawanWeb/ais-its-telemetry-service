import { isIsoDateTime } from '@darmawanweb/ais-its-contracts/api';
import {
  buildMessage,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

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
