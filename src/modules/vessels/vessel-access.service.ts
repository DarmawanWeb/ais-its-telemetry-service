import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import {
  OrganizationRequiredError,
  VesselAccessDeniedError,
  VesselNotFoundError,
} from '../../common/errors.js';
import type { TenantScope, Vessel } from './vessel.js';
import { VesselsRepository } from './vessels.repository.js';

/**
 * Tenancy of telemetry (spec §8.5: tenant-private): a vessel's organization
 * comes from the FLEET projection, never from the client, and must be the
 * principal's organization (API key: its organization; user: the active
 * one), unless the principal is a platform administrator.
 */
@Injectable()
export class VesselAccessService {
  constructor(private readonly vessels: VesselsRepository) {}

  /**
   * The vessels of `mmsis` the principal may read and write telemetry of,
   * by MMSI.
   *
   * @throws {VesselNotFoundError} `404` naming every MMSI that is not a live vessel.
   * @throws {VesselAccessDeniedError} `403` naming every vessel of another organization.
   */
  async accessible(
    mmsis: readonly number[],
    principal: Principal,
  ): Promise<ReadonlyMap<number, Vessel>> {
    const wanted = [...new Set(mmsis)];
    const found = new Map(
      (await this.vessels.findLive(wanted)).map((vessel) => [
        vessel.mmsi,
        vessel,
      ]),
    );
    const unknown = wanted.filter((mmsi) => !found.has(mmsi));
    if (unknown.length > 0) throw new VesselNotFoundError(unknown);
    const denied = wanted.filter(
      (mmsi) => !principal.canAccessOrg(found.get(mmsi)?.orgId ?? null),
    );
    if (denied.length > 0) throw new VesselAccessDeniedError(denied);
    return found;
  }

  /** {@link accessible} for one vessel. */
  async accessibleOne(mmsi: number, principal: Principal): Promise<Vessel> {
    const vessel = (await this.accessible([mmsi], principal)).get(mmsi);
    if (vessel === undefined) throw new VesselNotFoundError([mmsi]);
    return vessel;
  }
}

/**
 * Organizations a principal's lists cover: every one for platform
 * administrators, else the principal's (active) organization.
 *
 * @throws {OrganizationRequiredError} `403` for a user without an active organization.
 */
export function tenantScopeOf(principal: Principal): TenantScope {
  if (principal.isPlatformAdmin) return { kind: 'all' };
  if (principal.orgId === null) throw new OrganizationRequiredError();
  return { kind: 'org', orgId: principal.orgId };
}
