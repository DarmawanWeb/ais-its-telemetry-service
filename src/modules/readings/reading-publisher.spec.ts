import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { loadConfig } from '@darmawanweb/ais-its-nest';
import type {
  EventPublisher,
  NatsClient,
} from '@darmawanweb/ais-its-nest/nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../config.js';
import type { StoredReading } from './reading.js';
import { ReadingPublisher } from './reading-publisher.js';
import type { ReadingsRepository } from './readings.repository.js';

const config = loadConfig(configSchema, {
  env: { LOG_LEVEL: 'silent' },
  envFile: false,
  output: null,
});

function stored(minute: number): StoredReading {
  return {
    mmsi: 525005223,
    time: new Date(Date.UTC(2026, 10, 21, 10, minute)),
    periodStart: null,
    fuelMeTon: 0.4,
    fuelAeTon: 0.05,
    source: 'mqtt',
    deviceId: '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77',
    receivedAt: new Date(Date.UTC(2026, 10, 21, 10, minute, 5)),
  };
}

describe('ReadingPublisher', () => {
  const publishEvent = vi.fn<EventPublisher['publishEvent']>();
  const markPublished = vi.fn<ReadingsRepository['markPublished']>();
  let connected: boolean;
  let publisher: ReadingPublisher;

  beforeEach(() => {
    publishEvent
      .mockReset()
      .mockResolvedValue(
        {} as Awaited<ReturnType<EventPublisher['publishEvent']>>,
      );
    markPublished.mockReset().mockResolvedValue();
    connected = true;
    publisher = new ReadingPublisher(
      { publishEvent } as unknown as EventPublisher,
      { isConnected: () => connected } as unknown as NatsClient,
      { markPublished } as unknown as ReadingsRepository,
      config,
    );
  });

  it('publishes fuel.reading.recorded.v1 with Nats-Msg-Id <mmsi>:<time> and marks the readings', async () => {
    const readings = [stored(0), stored(1)];

    await expect(publisher.publishCommitted(readings)).resolves.toBe(2);

    expect(publishEvent).toHaveBeenCalledWith(
      EVENT_TYPES.FUEL_READING_RECORDED,
      {
        mmsi: 525005223,
        time: '2026-11-21T10:00:00.000Z',
        periodStart: null,
        fuelMeTon: 0.4,
        fuelAeTon: 0.05,
        deviceId: '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77',
        source: 'mqtt',
      },
      { msgId: '525005223:2026-11-21T10:00:00.000Z', timeoutMs: 5000 },
    );
    expect(markPublished).toHaveBeenCalledWith(readings);
  });

  it('leaves everything to the relay while NATS is disconnected', async () => {
    connected = false;
    await expect(publisher.publishCommitted([stored(0)])).resolves.toBe(0);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
  });

  it('marks only the published readings and stops after a failed round', async () => {
    const readings = Array.from({ length: 70 }, (_, minute) => stored(minute));
    publishEvent.mockImplementation((_type, _data, options) =>
      options?.msgId === '525005223:2026-11-21T10:03:00.000Z'
        ? Promise.reject(new Error('no responders'))
        : Promise.resolve(
            {} as Awaited<ReturnType<EventPublisher['publishEvent']>>,
          ),
    );

    await expect(publisher.publishCommitted(readings)).resolves.toBe(63);

    // First round of 64 tried (one failed), the remaining 6 never sent.
    expect(publishEvent).toHaveBeenCalledTimes(64);
    expect(markPublished.mock.calls[0]?.[0]).toHaveLength(63);
  });

  it('never throws when marking fails (the relay republishes)', async () => {
    markPublished.mockRejectedValue(new Error('connection reset'));
    await expect(publisher.publishCommitted([stored(0)])).resolves.toBe(1);
  });
});
