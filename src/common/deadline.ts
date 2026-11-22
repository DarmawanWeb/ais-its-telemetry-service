/**
 * Waits for `work` at most `timeoutMs` milliseconds without cancelling it:
 * past the deadline it keeps running in the background. Rejections count
 * as settled (the caller handles failures inside `work`). The timer never
 * keeps the process alive.
 *
 * @returns `true` when `work` settled in time, `false` when the deadline passed first.
 */
export async function settledWithin(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
