export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Enforces a minimum interval between request start times per host. */
export class HostRateLimiter {
  private nextSlot = new Map<string, number>();
  constructor(private intervalMs: number) {}
  setInterval(ms: number) {
    this.intervalMs = Math.max(this.intervalMs, ms);
  }
  async wait(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, at + this.intervalMs);
    if (at > now) await sleep(at - now);
  }
}

/** Runs `fn` over items with bounded concurrency; stops picking new items when shouldStop() is true. */
export async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>, shouldStop: () => boolean = () => false): Promise<Array<{ item: T; result: R }>> {
  const results: Array<{ item: T; result: R }> = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (index < items.length && !shouldStop()) {
      const item = items[index++];
      results.push({ item, result: await fn(item) });
    }
  });
  await Promise.all(workers);
  return results;
}
