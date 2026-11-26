import { loadConfig } from '@darmawanweb/ais-its-nest';
import type { AuditService } from '@darmawanweb/ais-its-nest/audit';
import { UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceNotMqttError } from '../../common/errors.js';
import { configSchema } from '../../config.js';
import type { VesselAccessService } from '../vessels/vessel-access.service.js';
import type { DeviceWithVessel } from './device.js';
import type { DevicesRepository } from './devices.repository.js';
import { DevicesService } from './devices.service.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const ORG = '0193a0f2-0000-7000-8000-00000000000a';
const DEVICE_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';

const device = (
  overrides: Partial<DeviceWithVessel> = {},
): DeviceWithVessel => ({
  id: DEVICE_ID,
  orgId: ORG,
  mmsi: 525005223,
  vesselName: 'KM Sinar Bahari',
  name: 'ME meter',
  kind: 'mqtt',
  apiKeyId: null,
  status: 'active',
  serialNumber: null,
  lastSeenAt: NOW,
  lastReadingAt: new Date(NOW.getTime() - 5 * 60_000),
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const admin = new UserPrincipal({
  id: '0193a0f2-0000-7000-8000-0000000000u1',
  sessionId: 's',
  orgId: ORG,
  roles: ['org_admin'],
  email: 'admin@x.io',
  name: 'Admin',
});

function serviceWith(
  env: Record<string, string>,
  findById: DevicesRepository['findById'] = () => Promise.resolve(device()),
): DevicesService {
  const config = loadConfig(configSchema, {
    env: { LOG_LEVEL: 'silent', ...env },
    envFile: false,
    output: null,
  });
  return new DevicesService(
    { findById } as unknown as DevicesRepository,
    {} as unknown as VesselAccessService,
    {} as unknown as AuditService,
    config,
    { now: () => NOW },
  );
}

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://telemetry_svc:secret@db:5432/aisits',
  INTERNAL_TOKEN: 'a-production-internal-token-0123456789',
};

describe('DevicesService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a device with its connection state and the thresholds of the state', async () => {
    await expect(serviceWith({}).get(DEVICE_ID, admin)).resolves.toMatchObject({
      vesselName: 'KM Sinar Bahari',
      connectionState: 'online',
      activeWindowMin: 10,
      offlineAfterMin: 1440,
    });
    await expect(
      serviceWith({ TELEMETRY_ACTIVE_WINDOW_MIN: '1' }).get(DEVICE_ID, admin),
    ).resolves.toMatchObject({ connectionState: 'idle', activeWindowMin: 1 });
  });

  it('describes the MQTT connection of mqtt devices and refuses http devices', async () => {
    await expect(
      serviceWith({
        TELEMETRY_MQTT_URL: 'mqtts://mqtt.example.org',
        TELEMETRY_MQTT_AUTH: 'password',
      }).connection(DEVICE_ID, admin),
    ).resolves.toMatchObject({
      brokerUrl: 'mqtts://mqtt.example.org:8883',
      tls: true,
      topic: `aisits/telemetry/${DEVICE_ID}`,
      username: DEVICE_ID,
    });
    await expect(
      serviceWith({}, () =>
        Promise.resolve(device({ kind: 'http', apiKeyId: ORG })),
      ).connection(DEVICE_ID, admin),
    ).rejects.toBeInstanceOf(DeviceNotMqttError);
  });

  it('warns at boot when production describes the development broker', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    serviceWith({}).onModuleInit();
    serviceWith({
      ...PRODUCTION,
      TELEMETRY_MQTT_URL: 'mqtts://mqtt.example.org:8883',
    }).onModuleInit();
    expect(warn).not.toHaveBeenCalled();

    serviceWith(PRODUCTION).onModuleInit();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('TELEMETRY_MQTT_URL');
  });
});
