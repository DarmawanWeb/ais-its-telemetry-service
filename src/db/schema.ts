// Drizzle definitions of the "telemetry" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `telemetry_svc`. */
export const serviceSchema = pg.pgSchema('telemetry');

const timestamptz = (name: string) =>
  pg.timestamp(name, { withTimezone: true, mode: 'date' });

/** Projection of the FLEET stream (`0001_init.sql`). */
export const vessels = serviceSchema.table(
  'vessels',
  {
    mmsi: pg.integer('mmsi').primaryKey(),
    vesselId: pg.uuid('vessel_id').notNull(),
    orgId: pg.uuid('org_id'),
    name: pg.text('name').notNull(),
    status: pg
      .text('status', { enum: ['active', 'inactive', 'laid_up'] })
      .notNull(),
    sourceUpdatedAt: timestamptz('source_updated_at').notNull(),
    deletedAt: timestamptz('deleted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    pg.unique('vessels_vessel_id_key').on(table.vesselId),
    pg.index('vessels_org_idx').on(table.orgId, table.mmsi),
  ],
);

/** Telemetry devices of an organization (`0001_init.sql`). */
export const devices = serviceSchema.table(
  'devices',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    name: pg.text('name').notNull(),
    kind: pg.text('kind', { enum: ['mqtt', 'http'] }).notNull(),
    apiKeyId: pg.uuid('api_key_id'),
    status: pg
      .text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    serialNumber: pg.text('serial_number'),
    lastSeenAt: timestamptz('last_seen_at'),
    createdBy: pg.uuid('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    pg.unique('devices_org_name_key').on(table.orgId, table.name),
    pg.unique('devices_org_api_key_key').on(table.orgId, table.apiKeyId),
    pg.index('devices_org_mmsi_idx').on(table.orgId, table.mmsi),
  ],
);

/** Fuel readings hypertable (`0001_init.sql`), PK `(mmsi, time)`. */
export const fuelReadings = serviceSchema.table(
  'fuel_readings',
  {
    time: timestamptz('time').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    deviceId: pg.uuid('device_id'),
    periodStart: timestamptz('period_start'),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    source: pg
      .text('source', { enum: ['device', 'mqtt', 'api', 'manual', 'import'] })
      .notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    publishedAt: timestamptz('published_at'),
  },
  (table) => [
    pg.primaryKey({
      name: 'fuel_readings_pkey',
      columns: [table.mmsi, table.time],
    }),
  ],
);

/** Publication work queue of the relay (`0001_init.sql`). */
export const fuelReadingsUnpublished = serviceSchema.table(
  'fuel_readings_unpublished',
  {
    mmsi: pg.integer('mmsi').notNull(),
    time: timestamptz('time').notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
  },
  (table) => [
    pg.primaryKey({
      name: 'fuel_readings_unpublished_pkey',
      columns: [table.mmsi, table.time],
    }),
    pg.index('fuel_readings_unpublished_received_idx').on(table.receivedAt),
  ],
);

/** Continuous aggregate of hourly sums (real time, `0002_fuel_aggregates.sql`). */
export const fuelHourly = serviceSchema
  .view('fuel_hourly', {
    bucket: timestamptz('bucket').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    /** `count(*)`. */
    readings: pg.bigint('readings', { mode: 'number' }).notNull(),
    firstTime: timestamptz('first_time').notNull(),
    lastTime: timestamptz('last_time').notNull(),
  })
  .existing();

/** Hierarchical continuous aggregate of daily sums (real time, `0002_fuel_aggregates.sql`). */
export const fuelDaily = serviceSchema
  .view('fuel_daily', {
    bucket: timestamptz('bucket').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    /** `sum(readings)` of `fuel_hourly` (numeric). */
    readings: pg.numeric('readings', { mode: 'number' }).notNull(),
    firstTime: timestamptz('first_time').notNull(),
    lastTime: timestamptz('last_time').notNull(),
  })
  .existing();
