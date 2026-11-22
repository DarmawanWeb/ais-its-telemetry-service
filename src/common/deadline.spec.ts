import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settledWithin } from './deadline.js';

describe('settledWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true as soon as the work settles, fulfilled or rejected', async () => {
    await expect(settledWithin(Promise.resolve('done'), 1000)).resolves.toBe(
      true,
    );
    await expect(
      settledWithin(Promise.reject(new Error('failed')), 1000),
    ).resolves.toBe(true);
  });

  it('resolves false at the deadline and leaves the work running', async () => {
    let finished = false;
    const work = new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve();
      }, 10_000);
    });

    const result = settledWithin(work, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(false);
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(9000);
    expect(finished).toBe(true);
  });
});
