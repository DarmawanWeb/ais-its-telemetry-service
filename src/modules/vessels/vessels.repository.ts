import type {
  VesselDeletedV1,
  VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { Vessel, VesselUpsertOutcome } from './vessel.js';

const { vessels } = schema;

/**
 * The `vessels` projection of the `FLEET` stream: MMSI → vessel and owning
 * organization, the input of every tenancy decision of the service.
 */
@Injectable()
export class VesselsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Applies a snapshot unless a newer state is stored (idempotent, safe for
   * redeliveries in any order):
   * - the vessel's own row wins when its snapshot or tombstone is newer;
   * - a new MMSI of the vessel replaces its old row;
   * - an MMSI held by another live vessel is taken over only by a newer
   *   snapshot (a tombstone of another vessel never blocks).
   */
  async upsert(snapshot: VesselSnapshotV1): Promise<VesselUpsertOutcome> {
    const updatedAt = new Date(snapshot.updatedAt);
    return this.db.transaction(async (tx) => {
      const [own] = await tx
        .select()
        .from(vessels)
        .where(eq(vessels.vesselId, snapshot.id))
        .for('update');
      if (own !== undefined && !olderThan(own, updatedAt)) return 'stale';
      if (own !== undefined && own.mmsi !== snapshot.mmsi) {
        await tx.delete(vessels).where(eq(vessels.mmsi, own.mmsi));
      }

      const values = {
        mmsi: snapshot.mmsi,
        vesselId: snapshot.id,
        orgId: snapshot.orgId,
        name: snapshot.name,
        status: snapshot.status,
        sourceUpdatedAt: updatedAt,
        deletedAt: null,
      };
      const applied = await tx
        .insert(vessels)
        .values(values)
        .onConflictDoUpdate({
          target: vessels.mmsi,
          set: { ...values, updatedAt: sql`now()` },
          setWhere: sql`CASE
            WHEN ${vessels.vesselId} = excluded.vessel_id
              THEN ${vessels.sourceUpdatedAt} < excluded.source_updated_at
                AND (${vessels.deletedAt} IS NULL OR ${vessels.deletedAt} < excluded.source_updated_at)
            ELSE ${vessels.deletedAt} IS NOT NULL
              OR ${vessels.sourceUpdatedAt} < excluded.source_updated_at
          END`,
        })
        .returning({ mmsi: vessels.mmsi });
      return applied.length > 0 ? 'applied' : 'stale';
    });
  }

  /** Tombstones a deleted vessel unless a newer snapshot is stored; `true` when it changed. */
  async markDeleted(deleted: VesselDeletedV1, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(vessels)
      .set({ deletedAt: at, updatedAt: sql`now()` })
      .where(
        and(
          eq(vessels.vesselId, deleted.id),
          isNull(vessels.deletedAt),
          lte(vessels.sourceUpdatedAt, at),
        ),
      )
      .returning({ mmsi: vessels.mmsi });
    return rows.length > 0;
  }

  /** The live (not deleted) vessels among `mmsis`. */
  async findLive(mmsis: readonly number[]): Promise<Vessel[]> {
    if (mmsis.length === 0) return [];
    return this.db
      .select(vesselColumns)
      .from(vessels)
      .where(and(inArray(vessels.mmsi, [...mmsis]), isNull(vessels.deletedAt)));
  }
}

const vesselColumns = {
  mmsi: vessels.mmsi,
  vesselId: vessels.vesselId,
  orgId: vessels.orgId,
  name: vessels.name,
  status: vessels.status,
  sourceUpdatedAt: vessels.sourceUpdatedAt,
  deletedAt: vessels.deletedAt,
};

/** `true` when the stored row (snapshot or tombstone) is older than `updatedAt`. */
function olderThan(
  row: { readonly sourceUpdatedAt: Date; readonly deletedAt: Date | null },
  updatedAt: Date,
): boolean {
  const stored = Math.max(
    row.sourceUpdatedAt.getTime(),
    row.deletedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  return stored < updatedAt.getTime();
}
