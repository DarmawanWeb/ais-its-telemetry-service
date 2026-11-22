import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { createValidationPipe } from '@darmawanweb/ais-its-nest/http';
import { describe, expect, it } from 'vitest';

import { UpdateDeviceDto } from './update-device.dto.js';

/** Validates a PATCH body as the global pipe of the kit does. */
async function validate(body: object): Promise<UpdateDeviceDto> {
  return (await createValidationPipe().transform(body, {
    type: 'body',
    metatype: UpdateDeviceDto,
  })) as UpdateDeviceDto;
}

async function fieldsRejected(body: object): Promise<string[]> {
  const error: unknown = await validate(body).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ValidationFailedError);
  // One entry per failed constraint (e.g. IsInt, Min, Max): compare the fields.
  const errors = (error as ValidationFailedError).errors ?? [];
  return [...new Set(errors.map((field) => field.field))];
}

describe('UpdateDeviceDto', () => {
  it.each(['mmsi', 'name', 'kind', 'status'])(
    'rejects null for the non-nullable field %s (400, never a NOT NULL violation)',
    async (field) => {
      expect(await fieldsRejected({ [field]: null })).toEqual([field]);
    },
  );

  it.each(['apiKeyId', 'serialNumber'])(
    'accepts null for %s (clears it)',
    async (field) => {
      expect(await validate({ [field]: null })).toMatchObject({
        [field]: null,
      });
    },
  );

  it('keeps absent fields absent and validates present ones', async () => {
    const empty = await validate({});
    expect(Object.values(empty).filter((v) => v !== undefined)).toEqual([]);
    expect(
      await validate({ name: '  AE meter ', status: 'inactive' }),
    ).toMatchObject({ name: 'AE meter', status: 'inactive' });
    expect(
      await fieldsRejected({
        mmsi: 12,
        name: ' ',
        kind: 'lora',
        status: 'broken',
        apiKeyId: 'key-1',
        serialNumber: '',
      }),
    ).toEqual(
      expect.arrayContaining([
        'mmsi',
        'name',
        'kind',
        'status',
        'apiKeyId',
        'serialNumber',
      ]),
    );
  });
});
