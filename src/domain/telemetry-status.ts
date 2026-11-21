/**
 * Telemetry "active" rule of the fuel-estimation method priority: a vessel's
 * telemetry is active while its newest reading is at most `windowMin`
 * minutes old, `now − lastReadingAt ≤ W` (readings slightly ahead of the
 * clock, within the accepted skew, count as active). Without readings it is
 * inactive. The emission service prefers telemetry fuel while it is active.
 *
 * Intentional change from legacy (spec §15.5): `FuelDataRepository.isActive`
 * divided the age in milliseconds by 10 000 instead of 60 000, so its
 * "1 minute" window was really 10 seconds; v2 counts minutes and makes the
 * window configurable (`TELEMETRY_ACTIVE_WINDOW_MIN`, default 10).
 *
 * @method fuel.method_selection
 * @param lastReadingAt measurement time of the newest reading, or `null`.
 * @param now current time.
 * @param windowMin active window W, minutes.
 * @see ../../../../docs/METHODOLOGY.md#fuel.method_selection
 * @see legacy-mvp-backend — be-legacy/src/repositories/ships/fuel-data.repository.ts (`isActive`)
 * @see platform-spec-v1-1 — docs/PLATFORM_SPEC.md §13.4 and §15.5
 */
export function isTelemetryActive(
  lastReadingAt: Date | null,
  now: Date,
  windowMin: number,
): boolean {
  if (lastReadingAt === null) return false;
  return now.getTime() - lastReadingAt.getTime() <= windowMin * 60_000;
}
