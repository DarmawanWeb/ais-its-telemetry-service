import { describe, expect, it } from 'vitest';

import { deviceConnectionState, deviceCredentialError } from './device.js';

const KEY_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';
const NOW = new Date('2026-11-21T10:00:00.000Z');
const MINUTE = 60_000;
const THRESHOLDS = { activeWindowMin: 10, offlineAfterMin: 1440 };

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

describe('deviceConnectionState', () => {
  const state = (
    lastReadingAt: Date | null,
    status: 'active' | 'inactive' = 'active',
    thresholds = THRESHOLDS,
  ) => deviceConnectionState({ status, lastReadingAt }, NOW, thresholds);
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

  it('is online while the newest reading is within the active window (the vessel "active" rule)', () => {
    expect(state(ago(0))).toBe('online');
    expect(state(ago(10))).toBe('online');
    // Readings ahead of the clock within the accepted skew count as online.
    expect(state(new Date(NOW.getTime() + 4 * MINUTE))).toBe('online');
  });

  it('is idle beyond the active window and offline beyond offlineAfterMin', () => {
    expect(state(new Date(ago(10).getTime() - 1))).toBe('idle');
    expect(state(ago(1440))).toBe('idle');
    expect(state(new Date(ago(1440).getTime() - 1))).toBe('offline');
    expect(
      state(ago(45), 'active', { activeWindowMin: 30, offlineAfterMin: 60 }),
    ).toBe('idle');
    expect(
      state(ago(61), 'active', { activeWindowMin: 30, offlineAfterMin: 60 }),
    ).toBe('offline');
  });

  it('is never before the first reading and inactive for a switched-off device', () => {
    expect(state(null)).toBe('never');
    expect(state(ago(1), 'inactive')).toBe('inactive');
    expect(state(null, 'inactive')).toBe('inactive');
  });
});
