import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  ilike,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { TenantScope } from '../vessels/vessel.js';
import {
  type Device,
  type DeviceChanges,
  type DeviceFilter,
  type DeviceWithVessel,
  LAST_SEEN_RESOLUTION_MS,
} from './device.js';

const { devices, vessels } = schema;

/** A device to insert (the database fills the timestamps). */
export type NewDevice = Omit<
  Device,
  'lastSeenAt' | 'lastReadingAt' | 'createdAt' | 'updatedAt'
>;

/** One page of devices and the total across pages. */
export interface DevicePage<T extends Device = Device> {
  readonly rows: T[];
  readonly total: number;
}

/** The columns of a device and the name of its vessel (joined on {@link liveVesselOfDevice}). */
const deviceWithVesselColumns = {
  ...getTableColumns(devices),
  vesselName: vessels.name,
};

/** The device's vessel while it is live in the FLEET projection (primary key lookup). */
const liveVesselOfDevice = and(
  eq(vessels.mmsi, devices.mmsi),
  isNull(vessels.deletedAt),
);

/** Escapes `%`, `_` and `\` so user input matches literally in LIKE patterns. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Drizzle access to `devices`. Queries of users are restricted to a
 * {@link TenantScope} in SQL; the lookups of the ingestion paths
 * ({@link findForIngest}, {@link findByApiKey}) are scoped by their caller.
 */
@Injectable()
export class DevicesRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Inserts a device; unique violations name `devices_org_name_key` / `devices_org_api_key_key`. */
  async insert(device: NewDevice): Promise<DeviceWithVessel> {
    const [row] = await this.db.insert(devices).values(device).returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return this.withVessel(row);
  }

  async findById(
    id: string,
    scope: TenantScope,
  ): Promise<DeviceWithVessel | undefined> {
    const [row] = await this.db
      .select(deviceWithVesselColumns)
      .from(devices)
      .leftJoin(vessels, liveVesselOfDevice)
      .where(and(eq(devices.id, id), scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** A device by id for an incoming device message (no tenant: the device defines it). */
  async findForIngest(id: string): Promise<Device | undefined> {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    return row;
  }

  /** The device of the organization linked to an API key, if any. */
  async findByApiKey(
    orgId: string,
    apiKeyId: string,
  ): Promise<Device | undefined> {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.apiKeyId, apiKeyId)))
      .limit(1);
    return row;
  }

  /**
   * Devices by vessel, then name (stable order for pagination), with the
   * names of their vessels (one primary-key lookup per row of the page).
   */
  async list(
    filter: DeviceFilter,
    scope: TenantScope,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<DevicePage<DeviceWithVessel>> {
    const where = and(scopeCondition(scope), ...filterConditions(filter));
    const [rows, totals] = await Promise.all([
      this.db
        .select(deviceWithVesselColumns)
        .from(devices)
        .leftJoin(vessels, liveVesselOfDevice)
        .where(where)
        .orderBy(asc(devices.mmsi), asc(devices.name), asc(devices.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db.select({ total: count() }).from(devices).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /** The devices of an organization on one vessel, by name. */
  async listOfVessel(
    orgId: string,
    mmsi: number,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<DevicePage> {
    const where = and(eq(devices.orgId, orgId), eq(devices.mmsi, mmsi));
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(devices)
        .where(where)
        .orderBy(asc(devices.name), asc(devices.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db.select({ total: count() }).from(devices).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /**
   * Applies `changes` and bumps `updated_at`; `undefined` when no device
   * matched. Moving the device to another vessel clears `last_reading_at` in
   * the same statement (the `CASE` reads the stored MMSI): its state then
   * follows its readings on the new vessel only, `never` until the first one
   * (`lastSeenAt`, receipt, is kept).
   */
  async update(
    id: string,
    scope: TenantScope,
    changes: DeviceChanges,
  ): Promise<DeviceWithVessel | undefined> {
    const [row] = await this.db
      .update(devices)
      .set({
        ...definedChanges(changes),
        ...(changes.mmsi === undefined
          ? {}
          : {
              lastReadingAt: sql`CASE WHEN ${devices.mmsi} = ${changes.mmsi} THEN ${devices.lastReadingAt} ELSE NULL END`,
            }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(devices.id, id), scopeCondition(scope)))
      .returning();
    return row === undefined ? undefined : this.withVessel(row);
  }

  /** Deletes a device and returns it; `undefined` when no device matched. */
  async delete(id: string, scope: TenantScope): Promise<Device | undefined> {
    const [row] = await this.db
      .delete(devices)
      .where(and(eq(devices.id, id), scopeCondition(scope)))
      .returning();
    return row;
  }

  /**
   * Records that the device delivered readings at `at`, the newest of them
   * measured at `lastReadingAt` (`null`: none of them is stored as the
   * device's) and stored on vessel `device.mmsi` (the device's vessel when the
   * batch was received). Writes when either timestamp advances by more than
   * {@link LAST_SEEN_RESOLUTION_MS} (busy devices do not rewrite the row for
   * every message) and never moves one back (`GREATEST` ignores `NULL`).
   * `last_reading_at` advances only while the device is still on that vessel:
   * a batch stored on the previous vessel of a device moved meanwhile
   * ({@link update}) refreshes `last_seen_at` only.
   */
  async markSeen(
    device: Pick<Device, 'id' | 'mmsi'>,
    at: Date,
    lastReadingAt: Date | null,
  ): Promise<void> {
    const seenBefore = new Date(at.getTime() - LAST_SEEN_RESOLUTION_MS);
    const readingAdvanced =
      lastReadingAt === null
        ? undefined
        : and(
            eq(devices.mmsi, device.mmsi),
            or(
              isNull(devices.lastReadingAt),
              lt(
                devices.lastReadingAt,
                new Date(lastReadingAt.getTime() - LAST_SEEN_RESOLUTION_MS),
              ),
            ),
          );
    await this.db
      .update(devices)
      .set({
        lastSeenAt: sql`GREATEST(${devices.lastSeenAt}, ${at})`,
        lastReadingAt: sql`CASE WHEN ${devices.mmsi} = ${device.mmsi} THEN GREATEST(${devices.lastReadingAt}, ${lastReadingAt}) ELSE ${devices.lastReadingAt} END`,
      })
      .where(
        and(
          eq(devices.id, device.id),
          or(
            isNull(devices.lastSeenAt),
            lt(devices.lastSeenAt, seenBefore),
            readingAdvanced,
          ),
        ),
      );
  }

  /** The device with the name of its live vessel (after a write: `RETURNING` cannot join). */
  private async withVessel(device: Device): Promise<DeviceWithVessel> {
    const [vessel] = await this.db
      .select({ name: vessels.name })
      .from(vessels)
      .where(and(eq(vessels.mmsi, device.mmsi), isNull(vessels.deletedAt)))
      .limit(1);
    return { ...device, vesselName: vessel?.name ?? null };
  }
}

function scopeCondition(scope: TenantScope): SQL | undefined {
  return scope.kind === 'all' ? undefined : eq(devices.orgId, scope.orgId);
}

function filterConditions(filter: DeviceFilter): (SQL | undefined)[] {
  const pattern =
    filter.search === undefined
      ? undefined
      : `%${escapeLikePattern(filter.search)}%`;
  return [
    filter.orgId === undefined ? undefined : eq(devices.orgId, filter.orgId),
    filter.mmsi === undefined ? undefined : eq(devices.mmsi, filter.mmsi),
    filter.kind === undefined ? undefined : eq(devices.kind, filter.kind),
    filter.status === undefined ? undefined : eq(devices.status, filter.status),
    pattern === undefined
      ? undefined
      : or(ilike(devices.name, pattern), ilike(devices.serialNumber, pattern)),
  ];
}

/** The changes without `undefined` members (absent means "keep", `null` clears). */
function definedChanges(
  changes: DeviceChanges,
): Partial<typeof devices.$inferInsert> {
  return {
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.mmsi === undefined ? {} : { mmsi: changes.mmsi }),
    ...(changes.kind === undefined ? {} : { kind: changes.kind }),
    ...(changes.apiKeyId === undefined ? {} : { apiKeyId: changes.apiKeyId }),
    ...(changes.status === undefined ? {} : { status: changes.status }),
    ...(changes.serialNumber === undefined
      ? {}
      : { serialNumber: changes.serialNumber }),
  };
}
