import type { PageQuery, Paginated } from '@darmawanweb/ais-its-contracts/api';
import { toPaginated, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import {
  type ApiKeyPrincipal,
  assertOrgAccess,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import {
  DeviceApiKeyTakenError,
  DeviceNameTakenError,
  DeviceNotFoundError,
  VesselAccessDeniedError,
  VesselWithoutOrganizationError,
} from '../../common/errors.js';
import { isUniqueViolation } from '../../db/errors.js';
import {
  tenantScopeOf,
  VesselAccessService,
} from '../vessels/vessel-access.service.js';
import {
  DEVICE_API_KEY_CONSTRAINT,
  DEVICE_NAME_CONSTRAINT,
  deviceCredentialError,
  type Device,
  type DeviceChanges,
  type DeviceFilter,
  type DeviceKind,
  type DeviceStatus,
} from './device.js';
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
 * kind, unique names and API keys per organization, and the audit trail.
 * Also serves the ingestion paths (device of an API key or an MQTT topic).
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly repository: DevicesRepository,
    private readonly vessels: VesselAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Registers a device on a vessel the principal may access. */
  async create(
    input: CreateDeviceInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<Device> {
    const { orgId } = await this.vessels.accessibleOne(input.mmsi, principal);
    if (orgId === null) throw new VesselWithoutOrganizationError(input.mmsi);
    const apiKeyId = input.apiKeyId ?? null;
    assertCredential(input.kind, apiKeyId);

    const device = await this.unique(input.name, apiKeyId, () =>
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
    return device;
  }

  /** A device visible to the principal, else `404 DEVICE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<Device> {
    const device = await this.repository.findById(id, tenantScopeOf(principal));
    if (device === undefined) throw new DeviceNotFoundError(id);
    return device;
  }

  /** One page of the devices visible to the principal. */
  async list(
    filter: DeviceFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<Device>> {
    if (filter.orgId !== undefined) assertOrgAccess(principal, filter.orgId);
    const { rows, total } = await this.repository.list(
      filter,
      tenantScopeOf(principal),
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
  ): Promise<Device> {
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

    const device = await this.unique(
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
    return device;
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

  /** Refreshes `lastSeenAt` after readings of the device were stored. */
  async markSeen(id: string, at: Date): Promise<void> {
    await this.repository.markSeen(id, at);
  }

  /** Runs a write and maps duplicate names / API keys to `409`. */
  private async unique<T>(
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
      throw error;
    }
  }
}

/** `400 VALIDATION_FAILED` unless the kind and the API key are consistent. */
function assertCredential(kind: DeviceKind, apiKeyId: string | null): void {
  const error = deviceCredentialError(kind, apiKeyId);
  if (error !== undefined) throw new ValidationFailedError([error]);
}
