/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // src/domain/telemetry-status.ts — isTelemetryActive (the "active" rule).
  'fuel.method_selection',
  // src/domain/fuel-aggregation.ts — addTotals / totalFuelTon (Σ readings per window).
  'telemetry.fuel_reading_usage',
];
