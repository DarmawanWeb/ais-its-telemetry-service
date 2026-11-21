/** Source of the current time (tests replace it with a fixed clock). */
export interface Clock {
  now(): Date;
}

/** Injection token of the {@link Clock}. */
export const CLOCK = Symbol('telemetry:clock');

/** The system clock. */
export const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => new Date() });
