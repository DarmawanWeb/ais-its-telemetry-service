import {
  type EventEnvelope,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** A `fuel.reading.recorded.v1` message read back from the FUEL stream. */
export interface FuelEvent {
  readonly subject: string;
  readonly msgId: string | undefined;
  readonly envelope: EventEnvelope;
}

/**
 * Reads the FUEL messages of a vessel the way a consumer (emission) would,
 * with an ordered consumer from the start of the stream, until `expected`
 * messages arrived or `timeoutMs` passed.
 */
export async function readFuelEvents(
  app: NestFastifyApplication,
  mmsi: number,
  expected: number,
  timeoutMs = 5000,
): Promise<FuelEvent[]> {
  const { jetstream } = await app.get(NatsClient).ready();
  const consumer = await jetstream.consumers.get('FUEL', {
    filter_subjects: [subjects.fuelReading(mmsi)],
  });
  const events: FuelEvent[] = [];
  const messages = await consumer.fetch({
    max_messages: Math.max(expected, 1),
    expires: timeoutMs,
  });
  for await (const message of messages) {
    const parsed = parseEnvelope(message.data);
    if (!parsed.success) throw new Error(`invalid FUEL message: ${parsed.message}`);
    events.push({
      subject: message.subject,
      msgId: message.headers?.get('Nats-Msg-Id'),
      envelope: parsed.envelope,
    });
    if (events.length >= expected) break;
  }
  await consumer.delete().catch(() => undefined);
  return events;
}
