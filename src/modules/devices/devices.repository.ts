import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
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
  LAST_SEEN_RESOLUTION_MS,
} from './device.js';

const { devices } = schema;

/** A device to insert (the database fills the timestamps). */
export type NewDevice = Omit<Device, 'lastSeenAt' | 'createdAt' | 'updatedAt'>;

/** One page of devices and the total across pages. */
export interface DevicePage {
  readonly rows: Device[];
  readonly total: number;
}

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
  async insert(device: NewDevice): Promise<Device> {
    const [row] = await this.db.insert(devices).values(device).returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  async findById(id: string, scope: TenantScope): Promise<Device | undefined> {
    const [row] = await this.db
      .select()
      .from(devices)
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

  /** Devices by vessel, then name (stable order for pagination). */
  async list(
    filter: DeviceFilter,
    scope: TenantScope,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<DevicePage> {
    const where = and(scopeCondition(scope), ...filterConditions(filter));
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(devices)
        .where(where)
        .orderBy(asc(devices.mmsi), asc(devices.name), asc(devices.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db.select({ total: count() }).from(devices).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /** Applies `changes` and bumps `updated_at`; `undefined` when no device matched. */
  async update(
    id: string,
    scope: TenantScope,
    changes: DeviceChanges,
  ): Promise<Device | undefined> {
    const [row] = await this.db
      .update(devices)
      .set({ ...definedChanges(changes), updatedAt: sql`now()` })
      .where(and(eq(devices.id, id), scopeCondition(scope)))
      .returning();
    return row;
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
   * Records that the device delivered readings at `at`; writes at most once
   * per {@link LAST_SEEN_RESOLUTION_MS} (busy devices do not rewrite the row
   * for every message) and never moves the timestamp back.
   */
  async markSeen(id: string, at: Date): Promise<void> {
    const threshold = new Date(at.getTime() - LAST_SEEN_RESOLUTION_MS);
    await this.db
      .update(devices)
      .set({ lastSeenAt: at })
      .where(
        and(
          eq(devices.id, id),
          or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, threshold)),
        ),
      );
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
