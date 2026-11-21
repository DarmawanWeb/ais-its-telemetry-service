/** A vessel of the FLEET projection (`vessels`). */
export interface Vessel {
  readonly mmsi: number;
  readonly vesselId: string;
  /** Owning organization; `null` = not assigned (platform administrators only). */
  readonly orgId: string | null;
  readonly name: string;
  readonly status: 'active' | 'inactive' | 'laid_up';
  /** `updatedAt` of the applied snapshot (ordering of late events). */
  readonly sourceUpdatedAt: Date;
  /** Tombstone of `fleet.vessel.deleted.v1`; `null` while the vessel exists. */
  readonly deletedAt: Date | null;
}

/** Result of applying a snapshot: `stale` when a newer state is stored already. */
export type VesselUpsertOutcome = 'applied' | 'stale';

/** Which organizations' records a query may see (spec §8.5). */
export type TenantScope =
  { readonly kind: 'org'; readonly orgId: string } | { readonly kind: 'all' };
