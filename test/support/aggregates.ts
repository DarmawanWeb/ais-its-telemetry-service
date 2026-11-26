import { setTimeout as sleep } from 'node:timers/promises';

import {
  PG_SQLSTATES,
  refreshContinuousAggregate,
  sqlStateOf,
} from '@darmawanweb/ais-its-nest/db';
import type { Pool } from 'pg';
import { expect } from 'vitest';

/** The continuous aggregates of `0002`, in refresh order (daily after hourly). */
export const FUEL_AGGREGATES = ['fuel_hourly', 'fuel_daily'] as const;

/** A {@link FUEL_AGGREGATES} member. */
export type FuelAggregate = (typeof FUEL_AGGREGATES)[number];

/** The refresh policy job of a continuous aggregate. */
export interface RefreshPolicy {
  readonly jobId: number;
  /** Whether the scheduler runs it (`alter_job(…, scheduled => …)`). */
  readonly scheduled: boolean;
}

/*
 * Policy jobs run concurrently with the tests: one starts as soon as its
 * policy is added (every boot of a fresh schema, and `app.int.test.ts`
 * recreates the fuel_daily one when it retries 0002), then on its schedule.
 * TimescaleDB refuses a refresh that overlaps one in progress at once, with
 * SQLSTATE 55P03 ("could not refresh continuous aggregate … due to a
 * concurrent refresh"), instead of waiting for it.
 */

/** Retries of a refresh refused because a policy run of the aggregate is in progress. */
const CONCURRENT_REFRESH_RETRIES = 8;

/** The refresh policy job of `view` (exactly one). */
export async function refreshPolicyOf(
  pool: Pool,
  view: FuelAggregate,
): Promise<RefreshPolicy> {
  const { rows } = await pool.query<{ job_id: number; scheduled: boolean }>(
    // jobs names the aggregate itself (TimescaleDB 2.32) or, in older
    // releases, its materialization hypertable.
    `SELECT j.job_id, j.scheduled FROM timescaledb_information.jobs j
     JOIN timescaledb_information.continuous_aggregates c
       ON c.view_schema = 'telemetry' AND c.view_name = $1
     WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
       AND ((j.hypertable_schema = c.view_schema AND j.hypertable_name = c.view_name)
         OR (j.hypertable_schema = c.materialization_hypertable_schema
             AND j.hypertable_name = c.materialization_hypertable_name))`,
    [view],
  );
  expect(rows, view).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error(`no refresh policy of ${view}`);
  return { jobId: row.job_id, scheduled: row.scheduled };
}

/** Pauses (`false`) or resumes (`true`) the schedules of both refresh policies. */
export async function scheduleRefreshPolicies(
  pool: Pool,
  scheduled: boolean,
): Promise<void> {
  for (const view of FUEL_AGGREGATES) {
    const { jobId } = await refreshPolicyOf(pool, view);
    await pool.query('SELECT alter_job($1, scheduled => $2)', [
      jobId,
      scheduled,
    ]);
  }
}

/**
 * Runs the refresh policy of `view` now, as its schedule would
 * (`CALL run_job`), retrying while a scheduled run of it is in progress.
 */
export async function runRefreshPolicy(
  pool: Pool,
  view: FuelAggregate,
): Promise<void> {
  const { jobId } = await refreshPolicyOf(pool, view);
  for (let retry = 1; ; retry += 1) {
    try {
      await pool.query('CALL run_job($1)', [jobId]);
      return;
    } catch (error) {
      if (
        sqlStateOf(error) !== PG_SQLSTATES.LOCK_NOT_AVAILABLE ||
        retry > CONCURRENT_REFRESH_RETRIES
      )
        throw error;
      await sleep(Math.min(250 * 2 ** (retry - 1), 4000));
    }
  }
}

/**
 * Refreshes both aggregates over their whole range, hourly first (the
 * manual refresh of the README's Troubleshooting), with their policy
 * schedules paused meanwhile, so that no run starts in between; a run already
 * in progress is waited out by the kit's retries of the `55P03` refusal. The
 * schedules are restored afterwards, also when a refresh fails.
 */
export async function refreshAggregates(pool: Pool): Promise<void> {
  const policies = [];
  for (const view of FUEL_AGGREGATES)
    policies.push(await refreshPolicyOf(pool, view));
  try {
    for (const { jobId } of policies)
      await pool.query('SELECT alter_job($1, scheduled => false)', [jobId]);
    for (const view of FUEL_AGGREGATES) {
      await refreshContinuousAggregate(pool, view, null, null, {
        retries: CONCURRENT_REFRESH_RETRIES,
      });
    }
  } finally {
    for (const { jobId, scheduled } of policies)
      await pool.query('SELECT alter_job($1, scheduled => $2)', [
        jobId,
        scheduled,
      ]);
  }
}
