import { subjects } from '@darmawanweb/ais-its-contracts/events';
import { loadConfig } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../config.js';
import type { Device } from '../devices/device.js';
import type { DevicesService } from '../devices/devices.service.js';
import type { Vessel } from '../vessels/vessel.js';
import type { VesselsRepository } from '../vessels/vessels.repository.js';
import { DeviceIngestService } from './device-ingest.service.js';
import type { ReadingIngestService } from './reading-ingest.service.js';
import { TelemetryMetrics } from './telemetry.metrics.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const ORG = '0193a0f2-0000-7000-8000-00000000000a';
const DEVICE_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';
const SUBJECT = subjects.telemetryMqtt(DEVICE_ID);
const config = loadConfig(configSchema, {
  env: { LOG_LEVEL: 'silent' },
  envFile: false,
  output: null,
});
const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const READING = {
  time: '2026-11-21T09:59:00Z',
  fuelMeTon: 0.4,
  fuelAeTon: 0.05,
};

const mqttDevice = (overrides: Partial<Device> = {}): Device => ({
  id: DEVICE_ID,
  orgId: ORG,
  mmsi: 525005223,
  name: 'ME meter',
  kind: 'mqtt',
  apiKeyId: null,
  status: 'active',
  serialNumber: null,
  lastSeenAt: null,
  lastReadingAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const vessel = (orgId: string | null): Vessel => ({
  mmsi: 525005223,
  vesselId: '0193a0f2-0000-7000-8000-000000000001',
  orgId,
  name: 'KM Test',
  status: 'active',
  sourceUpdatedAt: NOW,
  deletedAt: null,
});

describe('DeviceIngestService', () => {
  const deviceForMessage = vi.fn<DevicesService['deviceForMessage']>();
  const markSeen = vi.fn<DevicesService['markSeen']>();
  const findLive = vi.fn<VesselsRepository['findLive']>();
  const ingest = vi.fn<ReadingIngestService['ingest']>();
  let metrics: TelemetryMetrics;
  let service: DeviceIngestService;

  const counted = async (outcome: string): Promise<number> =>
    (await metrics.deviceMessages.get()).values.find(
      (value) => value.labels.outcome === outcome,
    )?.value ?? 0;

  beforeEach(() => {
    vi.resetAllMocks();
    deviceForMessage.mockResolvedValue(mqttDevice());
    findLive.mockResolvedValue([vessel(ORG)]);
    ingest.mockResolvedValue({
      received: 1,
      accepted: 1,
      duplicates: 0,
      conflicts: 0,
      latest: new Date(READING.time),
      published: 1,
    });
    metrics = new TelemetryMetrics(new MetricsService());
    service = new DeviceIngestService(
      { deviceForMessage, markSeen } as unknown as DevicesService,
      { findLive } as unknown as VesselsRepository,
      { ingest } as unknown as ReadingIngestService,
      metrics,
      config,
      { now: () => NOW },
    );
  });

  it('stores readings of an active mqtt device for the vessel of the device record', async () => {
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'accepted',
    );

    expect(ingest).toHaveBeenCalledWith(
      {
        readings: [
          {
            mmsi: 525005223,
            time: new Date(READING.time),
            periodStart: null,
            fuelMeTon: 0.4,
            fuelAeTon: 0.05,
          },
        ],
        source: 'mqtt',
        deviceId: DEVICE_ID,
      },
      // MQTT has no one to answer: conflicting readings are left out, the rest is stored.
      'skip',
    );
    // Receipt now, measured at the newest reading the store holds for the device.
    expect(markSeen).toHaveBeenCalledWith(
      DEVICE_ID,
      NOW,
      new Date(READING.time),
    );
    expect(await counted('accepted')).toBe(1);
  });

  it('counts a message of already stored readings as duplicate', async () => {
    ingest.mockResolvedValue({
      received: 1,
      accepted: 0,
      duplicates: 1,
      conflicts: 0,
      latest: new Date(READING.time),
      published: 0,
    });
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'duplicate',
    );
  });

  it('counts a message with readings that conflict with stored ones as conflict', async () => {
    ingest.mockResolvedValue({
      received: 2,
      accepted: 1,
      duplicates: 0,
      conflicts: 1,
      latest: new Date(READING.time),
      published: 1,
    });
    await expect(
      service.handle(SUBJECT, body([READING, { ...READING, time: NOW }])),
    ).resolves.toBe('conflict');
    expect(markSeen).toHaveBeenCalledWith(
      DEVICE_ID,
      NOW,
      new Date(READING.time),
    );
    expect(await counted('conflict')).toBe(1);
  });

  it.each([
    ['invalid_subject', 'aisits.telemetry.meter-7', body(READING)],
    ['invalid_json', SUBJECT, new TextEncoder().encode('{ fuel')],
    ['invalid_payload', SUBJECT, body({ time: READING.time })],
    ['invalid_payload', SUBJECT, body({ ...READING, fuelMeTon: -1 })],
    [
      'invalid_payload',
      SUBJECT,
      body({ ...READING, time: '2026-11-21T10:06:00Z' }),
    ],
  ])('rejects and counts %s messages', async (outcome, subject, data) => {
    await expect(service.handle(subject, data)).resolves.toBe(outcome);
    expect(ingest).not.toHaveBeenCalled();
    expect(await counted(outcome)).toBe(1);
  });

  it('rejects unknown, inactive and http devices', async () => {
    deviceForMessage.mockResolvedValueOnce(undefined);
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'unknown_device',
    );
    deviceForMessage.mockResolvedValueOnce(mqttDevice({ status: 'inactive' }));
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'inactive_device',
    );
    deviceForMessage.mockResolvedValueOnce(
      mqttDevice({ kind: 'http', apiKeyId: ORG }),
    );
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'transport_mismatch',
    );
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects devices whose vessel left the fleet or the organization', async () => {
    findLive.mockResolvedValueOnce([]);
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'vessel_not_found',
    );
    findLive.mockResolvedValueOnce([
      vessel('0193a0f2-0000-7000-8000-00000000000b'),
    ]);
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'vessel_mismatch',
    );
    expect(ingest).not.toHaveBeenCalled();
  });

  it('retries transient storage errors, then counts and throws', async () => {
    ingest.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(service.handle(SUBJECT, body(READING))).resolves.toBe(
      'accepted',
    );
    expect(ingest).toHaveBeenCalledTimes(2);

    ingest.mockReset().mockRejectedValue(new Error('database down'));
    await expect(service.handle(SUBJECT, body(READING))).rejects.toThrow(
      'database down',
    );
    expect(ingest).toHaveBeenCalledTimes(3);
    expect(await counted('error')).toBe(1);
  });
});
