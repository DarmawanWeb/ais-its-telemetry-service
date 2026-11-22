import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';

/**
 * `404 VESSEL_NOT_FOUND`: the MMSI is not a (live) vessel of the FLEET
 * projection; batches name every unknown MMSI in `mmsi`.
 */
export class VesselNotFoundError extends NotFoundError {
  override readonly name = 'VesselNotFoundError';

  constructor(mmsis: readonly number[]) {
    super(
      mmsis.length === 1
        ? `No vessel with MMSI ${mmsis[0]}`
        : `No vessels with MMSI ${mmsis.join(', ')}`,
      {
        code: 'VESSEL_NOT_FOUND',
        extra: { mmsi: mmsis.length === 1 ? mmsis[0] : [...mmsis] },
      },
    );
  }
}

/** `403 FORBIDDEN`: the vessels belong to another organization (spec §8.5). */
export class VesselAccessDeniedError extends ForbiddenError {
  override readonly name = 'VesselAccessDeniedError';

  constructor(mmsis: readonly number[]) {
    super(
      `Telemetry of MMSI ${mmsis.join(', ')} belongs to another organization`,
      { code: 'FORBIDDEN', extra: { mmsi: [...mmsis] } },
    );
  }
}

/** `403 ORGANIZATION_REQUIRED`: the user has no active organization. */
export class OrganizationRequiredError extends ForbiddenError {
  override readonly name = 'OrganizationRequiredError';

  constructor() {
    super('Select an organization first', { code: 'ORGANIZATION_REQUIRED' });
  }
}

/** `404 DEVICE_NOT_FOUND`: no device with the id is visible to the principal. */
export class DeviceNotFoundError extends NotFoundError {
  override readonly name = 'DeviceNotFoundError';

  constructor(id: string) {
    super(`No device with id ${id}`, {
      code: 'DEVICE_NOT_FOUND',
      extra: { id },
    });
  }
}

/** `403 DEVICE_INACTIVE`: the API key belongs to a device that is switched off. */
export class DeviceInactiveError extends ForbiddenError {
  override readonly name = 'DeviceInactiveError';

  constructor(deviceId: string) {
    super(`Device ${deviceId} is inactive`, {
      code: 'DEVICE_INACTIVE',
      extra: { deviceId },
    });
  }
}

/** `403 DEVICE_VESSEL_MISMATCH`: a device reports for a vessel it is not installed on. */
export class DeviceVesselMismatchError extends ForbiddenError {
  override readonly name = 'DeviceVesselMismatchError';

  constructor(deviceId: string, deviceMmsi: number, mmsis: readonly number[]) {
    super(
      `Device ${deviceId} is installed on MMSI ${deviceMmsi} and cannot report MMSI ${mmsis.join(', ')}`,
      {
        code: 'DEVICE_VESSEL_MISMATCH',
        extra: { deviceId, deviceMmsi, mmsi: [...mmsis] },
      },
    );
  }
}

/** `409 DEVICE_NAME_TAKEN`: the organization already has a device of that name. */
export class DeviceNameTakenError extends ConflictError {
  override readonly name = 'DeviceNameTakenError';

  constructor(name: string, cause: unknown) {
    super(`A device named "${name}" already exists`, {
      code: 'DEVICE_NAME_TAKEN',
      extra: { name },
      cause,
    });
  }
}

/** `409 DEVICE_API_KEY_TAKEN`: the API key is linked to another device already. */
export class DeviceApiKeyTakenError extends ConflictError {
  override readonly name = 'DeviceApiKeyTakenError';

  constructor(apiKeyId: string, cause: unknown) {
    super(`API key ${apiKeyId} is linked to another device`, {
      code: 'DEVICE_API_KEY_TAKEN',
      extra: { apiKeyId },
      cause,
    });
  }
}

/** A reading of a request that conflicts with a stored reading. */
export interface ReadingConflict {
  /** Index of the reading in the request body. */
  readonly index: number;
  readonly mmsi: number;
  readonly time: Date;
}

/**
 * `409 READING_CONFLICT`: the vessel has a different reading at that time
 * already (other amounts or period, or reported by another device).
 * Readings are immutable and keyed by `(mmsi, time)`, so nothing of the
 * request was stored; `errors` names each conflicting reading as
 * `<index>.time`. The stored reading is not disclosed (ingest-only API keys
 * cannot read telemetry).
 */
export class ReadingConflictError extends DomainError {
  override readonly name = 'ReadingConflictError';

  constructor(conflicts: readonly ReadingConflict[]) {
    super('READING_CONFLICT', {
      status: 409,
      title: 'Reading conflict',
      detail:
        conflicts.length === 1
          ? 'A different reading of the vessel is stored at that time already; readings are immutable'
          : `${conflicts.length} readings conflict with different readings stored at the same vessel and time; readings are immutable`,
      errors: conflicts.map((conflict) => ({
        field: `${conflict.index}.time`,
        message: `MMSI ${conflict.mmsi} has a different reading at ${conflict.time.toISOString()} already`,
        code: 'conflict',
      })),
    });
  }
}

/**
 * `409 DEVICE_CREDENTIAL_CONFLICT`: the kind and the API key of a device no
 * longer fit together after a concurrent change (`devices_kind_api_key_check`
 * refused the update that was validated against an older state).
 */
export class DeviceCredentialConflictError extends DomainError {
  override readonly name = 'DeviceCredentialConflictError';

  constructor(cause: unknown) {
    super('DEVICE_CREDENTIAL_CONFLICT', {
      status: 409,
      title: 'Device credential conflict',
      detail:
        'The device was changed concurrently and its kind no longer matches its API key; reload it and retry',
      cause,
    });
  }
}

/** `422 VESSEL_WITHOUT_ORGANIZATION`: devices need a vessel owned by an organization. */
export class VesselWithoutOrganizationError extends DomainError {
  override readonly name = 'VesselWithoutOrganizationError';

  constructor(mmsi: number) {
    super('VESSEL_WITHOUT_ORGANIZATION', {
      status: 422,
      title: 'Vessel without organization',
      detail: `Vessel ${mmsi} belongs to no organization; assign it in the fleet service first`,
      extra: { mmsi },
    });
  }
}
