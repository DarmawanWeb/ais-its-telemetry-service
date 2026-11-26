import { ApiProperty } from '@nestjs/swagger';

import {
  MQTT_AUTHENTICATIONS,
  MQTT_PROTOCOL_VERSION,
  MQTT_PUBLISH_QOS,
  type MqttAuthentication,
  type MqttConnection,
} from '../device-connection.js';

/** `GET /telemetry/devices/:id/connection`: how an mqtt device connects and publishes. */
export class DeviceConnectionDto {
  @ApiProperty({ format: 'uuid' })
  readonly deviceId: string;

  @ApiProperty({
    example: 'mqtts://mqtt.example.org:8883',
    description:
      'The platform broker as devices reach it (TELEMETRY_MQTT_URL, port explicit): mqtts = TLS',
  })
  readonly brokerUrl: string;

  @ApiProperty({ example: 'mqtt.example.org' })
  readonly host: string;

  @ApiProperty({ example: 8883 })
  readonly port: number;

  @ApiProperty({
    description: 'The broker requires TLS (an mqtts:// broker URL)',
  })
  readonly tls: boolean;

  @ApiProperty({
    enum: [MQTT_PROTOCOL_VERSION],
    description:
      'MQTT version to connect with (protocol level 4): the NATS MQTT gateway implements MQTT 3.1.1, not MQTT 5',
  })
  readonly protocolVersion: typeof MQTT_PROTOCOL_VERSION;

  @ApiProperty({
    example: 'aisits/telemetry/0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77',
    description:
      'The topic the device publishes its readings to (only its own)',
  })
  readonly topic: string;

  @ApiProperty({
    enum: [MQTT_PUBLISH_QOS],
    description:
      'QoS to publish with: at least once (QoS 0 messages sent just before a disconnect can be lost; repeats are stored once)',
  })
  readonly qos: typeof MQTT_PUBLISH_QOS;

  @ApiProperty({
    enum: MQTT_AUTHENTICATIONS,
    description:
      'none: the broker accepts any client (development); password: the device logs in as its own broker user, ' +
      'whose password the platform operator provisions (never issued or returned by this API)',
  })
  readonly authentication: MqttAuthentication;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0193a0f2-6c1e-7a52-9d4b-3c8f0e2a1b77',
    description:
      'The device’s broker user (its id) under password authentication; null without authentication',
  })
  readonly username: string | null;

  constructor(connection: MqttConnection) {
    this.deviceId = connection.deviceId;
    this.brokerUrl = connection.brokerUrl;
    this.host = connection.host;
    this.port = connection.port;
    this.tls = connection.tls;
    this.protocolVersion = connection.protocolVersion;
    this.topic = connection.topic;
    this.qos = connection.qos;
    this.authentication = connection.authentication;
    this.username = connection.username;
  }
}
