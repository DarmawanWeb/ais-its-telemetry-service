import { telemetryMqttTopic } from '@darmawanweb/ais-its-contracts/events';

import type { Device } from './device.js';

/**
 * How the platform's MQTT broker authenticates devices
 * (`TELEMETRY_MQTT_AUTH`): `none` — any client may connect and publish (the
 * development broker of `infra/compose`); `password` — one broker user per
 * device, named by the device id and allowed to publish to the device's
 * subject only, provisioned with its password by the platform operator
 * (`infra/nats/nats.conf`, production section).
 */
export const MQTT_AUTHENTICATIONS = ['none', 'password'] as const;

/** A {@link MQTT_AUTHENTICATIONS} member. */
export type MqttAuthentication = (typeof MQTT_AUTHENTICATIONS)[number];

/** The MQTT version of the NATS MQTT gateway (it implements MQTT 3.1.1 only). */
export const MQTT_PROTOCOL_VERSION = '3.1.1';

/**
 * QoS devices publish with: at least once. A QoS 0 message published right
 * before the client disconnects can be lost (`infra/README.md`); repeats of
 * QoS 1 are harmless, the service stores a reading once per `(mmsi, time)`.
 */
export const MQTT_PUBLISH_QOS = 1;

/** IANA ports of MQTT: 1883 plain, 8883 over TLS. */
const DEFAULT_PORTS = { mqtt: 1883, mqtts: 8883 } as const;

/** The platform's MQTT broker as devices reach it. */
export interface MqttBroker {
  /** `mqtt://host:port` or `mqtts://host:port` (the port always explicit). */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The broker requires TLS (`mqtts`). */
  readonly tls: boolean;
  readonly authentication: MqttAuthentication;
}

/** Inputs of {@link mqttBrokerOf}: the validated configuration. */
export interface MqttBrokerSettings {
  /** `TELEMETRY_MQTT_URL`, `mqtt://host[:port]` or `mqtts://host[:port]`. */
  readonly url: string;
  /** `TELEMETRY_MQTT_AUTH`; unset: `password` in production, `none` otherwise. */
  readonly authentication: MqttAuthentication | undefined;
  readonly production: boolean;
}

/**
 * The broker of a validated `TELEMETRY_MQTT_URL`: host (an IPv6 address
 * without its brackets), the port (default 1883, or 8883 for `mqtts`), and
 * the URL rebuilt with the explicit port.
 */
export function mqttBrokerOf(settings: MqttBrokerSettings): MqttBroker {
  const url = new URL(settings.url);
  const scheme = url.protocol === 'mqtts:' ? 'mqtts' : 'mqtt';
  const port = url.port === '' ? DEFAULT_PORTS[scheme] : Number(url.port);
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return {
    url: `${scheme}://${url.hostname}:${port}`,
    host,
    port,
    tls: scheme === 'mqtts',
    authentication:
      settings.authentication ?? (settings.production ? 'password' : 'none'),
  };
}

/** How an `mqtt` device connects and publishes its readings. */
export interface MqttConnection {
  readonly deviceId: string;
  readonly brokerUrl: string;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly protocolVersion: typeof MQTT_PROTOCOL_VERSION;
  /** The device's own topic, `aisits/telemetry/<deviceId>`. */
  readonly topic: string;
  readonly qos: typeof MQTT_PUBLISH_QOS;
  readonly authentication: MqttAuthentication;
  /**
   * The device's broker user (its id) when the broker authenticates devices;
   * `null` without authentication. Never a password: the platform operator
   * provisions it with the broker user.
   */
  readonly username: string | null;
}

/** The connection of an `mqtt` device to the broker. */
export function mqttConnectionOf(
  device: Pick<Device, 'id'>,
  broker: MqttBroker,
): MqttConnection {
  return {
    deviceId: device.id,
    brokerUrl: broker.url,
    host: broker.host,
    port: broker.port,
    tls: broker.tls,
    protocolVersion: MQTT_PROTOCOL_VERSION,
    topic: telemetryMqttTopic(device.id),
    qos: MQTT_PUBLISH_QOS,
    authentication: broker.authentication,
    username: broker.authentication === 'password' ? device.id : null,
  };
}
