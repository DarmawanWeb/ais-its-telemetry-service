import type { PageQuery, Paginated } from '@darmawanweb/ais-its-contracts/api';
import { toPaginated, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { InjectConfig, ValidationFailedError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import {
  type ApiKeyPrincipal,
  assertOrgAccess,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import {
  databaseErrorInfo,
  isUniqueViolation,
  PG_SQLSTATES,
} from '@darmawanweb/ais-its-nest/db';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { CLOCK, type Clock } from '../../common/clock.js';
import {
  DeviceApiKeyTakenError,
  DeviceCredentialConflictError,
  DeviceNameTakenError,
  DeviceNotFoundError,
  DeviceNotMqttError,
  VesselAccessDeniedError,
  VesselWithoutOrganizationError,
} from '../../common/errors.js';
import { type Config, DEV_MQTT_URL } from '../../config.js';
import {
  tenantScopeOf,
  VesselAccessService,
} from '../vessels/vessel-access.service.js';
import {
  type ConnectionThresholds,
  DEVICE_API_KEY_CONSTRAINT,
  DEVICE_CREDENTIAL_CONSTRAINT,
  DEVICE_NAME_CONSTRAINT,
  deviceConnectionState,
  deviceCredentialError,
  type Device,
  type DeviceChanges,
  type DeviceFilter,
  type DeviceKind,
  type DeviceStatus,
  type DeviceView,
  type DeviceWithVessel,
} from './device.js';
import {
  type MqttBroker,
  mqttBrokerOf,
  type MqttConnection,
  mqttConnectionOf,
} from './device-connection.js';
import { DevicesRepository } from './devices.repository.js';

/** Fields of a new device. */
export interface CreateDeviceInput {
  readonly mmsi: number;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly apiKeyId?: string | undefined;
  readonly status?: DeviceStatus | undefined;
  readonly serialNumber?: string | undefined;
}

/**
 * Use cases of the device registry (`device:manage`): tenancy (a device
 * belongs to the organization of its vessel), the credential rule of its
 * kind, unique names and API keys per organization, the connection state and
 * MQTT connection of a device, and the audit trail. Also serves the
 * ingestion paths (device of an API key or an MQTT topic).
 */
@Injectable()
export class DevicesService implements OnModuleInit {
  private readonly logger = new Logger(DevicesService.name);
  private readonly thresholds: ConnectionThresholds;
  private readonly broker: MqttBroker;

  constructor(
    private readonly repository: DevicesRepository,
    private readonly vessels: VesselAccessService,
    private readonly audit: AuditService,
    @InjectConfig() private readonly config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.thresholds = {
      activeWindowMin: config.TELEMETRY_ACTIVE_WINDOW_MIN,
      offlineAfterMin: config.TELEMETRY_DEVICE_OFFLINE_AFTER_MIN,
    };
    this.broker = mqttBrokerOf({
      url: config.TELEMETRY_MQTT_URL,
      authentication: config.TELEMETRY_MQTT_AUTH,
      production: config.NODE_ENV === 'production',
    });
  }

  /** Warns when production would describe the development broker to administrators. */
  onModuleInit(): void {
    if (
      this.config.NODE_ENV === 'production' &&
      this.config.TELEMETRY_MQTT_URL === DEV_MQTT_URL
    ) {
      this.logger.warn(
        `TELEMETRY_MQTT_URL is the development default ${DEV_MQTT_URL}: GET /telemetry/devices/:id/connection describes it to administrators; set the broker URL devices reach (e.g. mqtts://mqtt.example.org:8883)`,
      );
    }
  }

  /** Registers a device on a vessel the principal may access. */
  async create(
    input: CreateDeviceInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<DeviceView> {
    const { orgId } = await this.vessels.accessibleOne(input.mmsi, principal);
    if (orgId === null) throw new VesselWithoutOrganizationError(input.mmsi);
    const apiKeyId = input.apiKeyId ?? null;
    assertCredential(input.kind, apiKeyId);

    const device = await this.mapConstraintErrors(input.name, apiKeyId, () =>
      this.repository.insert({
        id: newId(),
        orgId,
        mmsi: input.mmsi,
        name: input.name,
        kind: input.kind,
        apiKeyId,
        status: input.status ?? 'active',
        serialNumber: input.serialNumber ?? null,
        createdBy: principal.kind === 'user' ? principal.id : null,
      }),
    );
    await this.audit.record(
      {
        action: 'device.create',
        targetType: 'device',
        targetId: device.id,
        orgId: device.orgId,
        meta: { mmsi: device.mmsi, kind: device.kind },
      },
      principal,
      request,
    );
    return this.view(device);
  }

  /** A device visible to the principal, else `404 DEVICE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<DeviceView> {
    return this.view(await this.find(id, principal));
  }

  /** One page of the devices visible to the principal. */
  async list(
    filter: DeviceFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<DeviceView>> {
    if (filter.orgId !== undefined) assertOrgAccess(principal, filter.orgId);
    const { rows, total } = await this.repository.list(
      filter,
      tenantScopeOf(principal),
      { offset: pageOffset(page), limit: page.pageSize },
    );
    const now = this.clock.now();
    return toPaginated(
      rows.map((row) => this.view(row, now)),
      page,
      total,
    );
  }

  /**
   * How an `mqtt` device visible to the principal connects to the
   * platform's broker (`TELEMETRY_MQTT_URL`, `TELEMETRY_MQTT_AUTH`) and
   * publishes: topic, QoS and its broker user. No secret: the broker, not
   * this service, authenticates devices.
   *
   * @throws {DeviceNotFoundError} `404` for devices the principal cannot see.
   * @throws {DeviceNotMqttError} `409` for `http` devices.
   */
  async connection(id: string, principal: Principal): Promise<MqttConnection> {
    const device = await this.find(id, principal);
    if (device.kind !== 'mqtt') throw new DeviceNotMqttError(id);
    return mqttConnectionOf(device, this.broker);
  }

  /**
   * The devices of a vessel the principal may read telemetry of (`telemetry:read`),
   * by name: those of the vessel's current organization, as the telemetry
   * overview counts them.
   *
   * @throws {VesselNotFoundError} `404` when the MMSI is not a live vessel.
   * @throws {VesselAccessDeniedError} `403` for a vessel of another organization.
   */
  async listOfVessel(
    mmsi: number,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<Device>> {
    const vessel = await this.vessels.accessibleOne(mmsi, principal);
    if (vessel.orgId === null) return toPaginated([], page, 0);
    const { rows, total } = await this.repository.listOfVessel(
      vessel.orgId,
      mmsi,
      { offset: pageOffset(page), limit: page.pageSize },
    );
    return toPaginated(rows, page, total);
  }

  /**
   * Changes a device; an empty change set returns it unchanged. A device
   * moves only between vessels of its organization, and the result must
   * satisfy the credential rule of its kind.
   */
  async update(
    id: string,
    changes: DeviceChanges,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<DeviceView> {
    const current = await this.get(id, principal);
    const fields = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    if (fields.length === 0) return current;

    if (changes.mmsi !== undefined && changes.mmsi !== current.mmsi) {
      const vessel = await this.vessels.accessibleOne(changes.mmsi, principal);
      if (vessel.orgId !== current.orgId) {
        throw new VesselAccessDeniedError([changes.mmsi]);
      }
    }
    const apiKeyId =
      changes.apiKeyId === undefined ? current.apiKeyId : changes.apiKeyId;
    assertCredential(changes.kind ?? current.kind, apiKeyId);

    const device = await this.mapConstraintErrors(
      changes.name ?? current.name,
      apiKeyId,
      () => this.repository.update(id, tenantScopeOf(principal), changes),
    );
    if (device === undefined) throw new DeviceNotFoundError(id);
    await this.audit.record(
      {
        action: 'device.update',
        targetType: 'device',
        targetId: id,
        orgId: device.orgId,
        meta: { fields },
      },
      principal,
      request,
    );
    return this.view(device);
  }

  /** Deletes a device; its readings keep their `deviceId` as history. */
  async remove(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<void> {
    const deleted = await this.repository.delete(id, tenantScopeOf(principal));
    if (deleted === undefined) throw new DeviceNotFoundError(id);
    await this.audit.record(
      {
        action: 'device.delete',
        targetType: 'device',
        targetId: id,
        orgId: deleted.orgId,
        meta: { mmsi: deleted.mmsi },
      },
      principal,
      request,
    );
  }

  /** The device an API key belongs to (readings of the key are attributed to it). */
  async deviceOfApiKey(
    principal: ApiKeyPrincipal,
  ): Promise<Device | undefined> {
    return this.repository.findByApiKey(principal.orgId, principal.id);
  }

  /** The device of an MQTT topic, whatever its organization or status. */
  async deviceForMessage(id: string): Promise<Device | undefined> {
    return this.repository.findForIngest(id);
  }

  /**
   * Refreshes `lastSeenAt` (receipt) and `lastReadingAt` (the measurement
   * time of the newest reading of the batch now stored as the device's, new
   * or a duplicate; `null` when every reading conflicted) after a batch of
   * the device was stored.
   */
  async markSeen(
    id: string,
    at: Date,
    lastReadingAt: Date | null,
  ): Promise<void> {
    await this.repository.markSeen(id, at, lastReadingAt);
  }

  /** A device visible to the principal, else `404 DEVICE_NOT_FOUND`. */
  private async find(
    id: string,
    principal: Principal,
  ): Promise<DeviceWithVessel> {
    const device = await this.repository.findById(id, tenantScopeOf(principal));
    if (device === undefined) throw new DeviceNotFoundError(id);
    return device;
  }

  /** The device with its connection state now and the thresholds of the state. */
  private view(
    device: DeviceWithVessel,
    now: Date = this.clock.now(),
  ): DeviceView {
    return {
      ...device,
      ...this.thresholds,
      connectionState: deviceConnectionState(device, now, this.thresholds),
    };
  }

  /**
   * Runs a write and maps constraint violations to domain errors: duplicate
   * names / API keys `409`; a kind/API-key pair that no longer fits after a
   * concurrent change (`devices_kind_api_key_check`; the rule was checked
   * against an older read) `409`; a `null` for a NOT NULL column or another
   * CHECK the DTOs did not catch `400`, never `500`.
   */
  private async mapConstraintErrors<T>(
    name: string,
    apiKeyId: string | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, DEVICE_NAME_CONSTRAINT)) {
        throw new DeviceNameTakenError(name, error);
      }
      if (
        apiKeyId !== null &&
        isUniqueViolation(error, DEVICE_API_KEY_CONSTRAINT)
      ) {
        throw new DeviceApiKeyTakenError(apiKeyId, error);
      }
      const pg = databaseErrorInfo(error);
      if (
        pg?.code === PG_SQLSTATES.CHECK_VIOLATION &&
        pg.constraint === DEVICE_CREDENTIAL_CONSTRAINT
      ) {
        throw new DeviceCredentialConflictError(error);
      }
      if (pg?.code === PG_SQLSTATES.NOT_NULL_VIOLATION) {
        const field = pg.column ?? 'body';
        throw new ValidationFailedError([
          { field, message: `${field} must not be null`, code: 'required' },
        ]);
      }
      if (pg?.code === PG_SQLSTATES.CHECK_VIOLATION) {
        throw new ValidationFailedError([
          {
            field: 'body',
            message: `the device violates ${pg.constraint ?? 'a check constraint'}`,
            code: 'constraint',
          },
        ]);
      }
      throw error;
    }
  }
}

/** `400 VALIDATION_FAILED` unless the kind and the API key are consistent. */
function assertCredential(kind: DeviceKind, apiKeyId: string | null): void {
  const error = deviceCredentialError(kind, apiKeyId);
  if (error !== undefined) throw new ValidationFailedError([error]);
}
