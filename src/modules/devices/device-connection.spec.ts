import { describe, expect, it } from 'vitest';

import { mqttBrokerOf, mqttConnectionOf } from './device-connection.js';

const DEVICE_ID = '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77';

const broker = (
  url: string,
  authentication?: 'none' | 'password',
  production = false,
) => mqttBrokerOf({ url, authentication, production });

describe('mqttBrokerOf', () => {
  it('makes the IANA default port explicit: 1883 plain, 8883 TLS', () => {
    expect(broker('mqtt://localhost')).toEqual({
      url: 'mqtt://localhost:1883',
      host: 'localhost',
      port: 1883,
      tls: false,
      authentication: 'none',
    });
    expect(broker('mqtts://mqtt.example.org')).toMatchObject({
      url: 'mqtts://mqtt.example.org:8883',
      port: 8883,
      tls: true,
    });
  });

  it('keeps an explicit port, and IPv6 hosts in brackets only in the URL', () => {
    expect(broker('mqtts://mqtt.example.org:443/')).toMatchObject({
      url: 'mqtts://mqtt.example.org:443',
      port: 443,
      tls: true,
    });
    expect(broker('mqtt://[::1]:1884')).toMatchObject({
      url: 'mqtt://[::1]:1884',
      host: '::1',
      port: 1884,
    });
  });

  it('defaults to password authentication in production and none elsewhere', () => {
    expect(broker('mqtt://localhost').authentication).toBe('none');
    expect(
      broker('mqtts://mqtt.example.org', undefined, true).authentication,
    ).toBe('password');
    expect(broker('mqtt://localhost', 'password').authentication).toBe(
      'password',
    );
    expect(
      broker('mqtts://mqtt.example.org', 'none', true).authentication,
    ).toBe('none');
  });
});

describe('mqttConnectionOf', () => {
  it('describes the broker, the device topic, QoS 1 and MQTT 3.1.1', () => {
    expect(
      mqttConnectionOf({ id: DEVICE_ID }, broker('mqtts://mqtt.example.org')),
    ).toEqual({
      deviceId: DEVICE_ID,
      brokerUrl: 'mqtts://mqtt.example.org:8883',
      host: 'mqtt.example.org',
      port: 8883,
      tls: true,
      protocolVersion: '3.1.1',
      topic: `aisits/telemetry/${DEVICE_ID}`,
      qos: 1,
      authentication: 'none',
      username: null,
    });
  });

  it('names the broker user of the device (its id) under password authentication, never a password', () => {
    const connection = mqttConnectionOf(
      { id: DEVICE_ID },
      broker('mqtts://mqtt.example.org', 'password'),
    );
    expect(connection).toMatchObject({
      authentication: 'password',
      username: DEVICE_ID,
    });
    expect(Object.keys(connection)).not.toContain('password');
  });
});
