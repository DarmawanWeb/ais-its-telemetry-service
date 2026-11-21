import { describe, expect, it } from 'vitest';

import { deviceCredentialError } from './device.js';

const KEY_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';

describe('deviceCredentialError', () => {
  it('accepts http devices with an API key and mqtt devices without', () => {
    expect(deviceCredentialError('http', KEY_ID)).toBeUndefined();
    expect(deviceCredentialError('mqtt', null)).toBeUndefined();
  });

  it('requires the API key of http devices', () => {
    expect(deviceCredentialError('http', null)).toMatchObject({
      field: 'apiKeyId',
      code: 'required',
    });
  });

  it('refuses an API key on mqtt devices', () => {
    expect(deviceCredentialError('mqtt', KEY_ID)).toMatchObject({
      field: 'apiKeyId',
      code: 'forbidden',
    });
  });
});
