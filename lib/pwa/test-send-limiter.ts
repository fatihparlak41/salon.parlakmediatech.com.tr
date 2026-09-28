/**
 * Faz ACCOUNT.1 (security) — abuse limits for the manual "test notification".
 *
 * Every active member may press "Test bildirimi gönder" (it only ever
 * reaches THEIR OWN devices, see sendTestPushNotificationAction), so it must
 * not be usable as a request cannon: each press costs a service-role RPC and
 * one outbound HTTPS request per device.
 *
 * Limits, all sliding windows:
 *   per USER   at least 5 s between presses, at most 6 per 10 minutes
 *   per DEVICE at most 3 per 10 minutes (a device = one push_subscriptions row)
 *   per PRESS  at most 5 devices are contacted
 *
 * HONEST SCOPE: state lives in this server instance's memory. On a
 * serverless platform each warm instance keeps its own counters, so a caller
 * who is spread across several instances can exceed the numbers by up to the
 * number of instances they reach — the limits are a real brake for the
 * normal case (repeated clicks, a script hammering one endpoint) and cap the
 * blast radius, but they are not a cryptographic guarantee. A durable,
 * cross-instance limiter needs a small table + RPC (a migration) and is
 * tracked as a follow-up rather than smuggled into this change.
 *
 * Pure (injectable clock) so it is fully unit-testable.
 */

export type LimiterConfig = {
  /** Minimum gap between two accepted attempts for the same key. 0 = none. */
  minIntervalMs: number;
  /** Maximum accepted attempts inside `windowMs`. */
  maxPerWindow: number;
  windowMs: number;
};

export type LimiterDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; reason: "too_soon" | "window_full" };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly config: LimiterConfig,
    private readonly now: () => number = Date.now,
    /** Bounds memory: the oldest key is evicted past this many distinct keys. */
    private readonly maxKeys = 5000,
  ) {}

  private recent(key: string, at: number): number[] {
    const windowStart = at - this.config.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Pure read: would an attempt for `key` be accepted right now? */
  check(key: string): LimiterDecision {
    const at = this.now();
    const list = this.recent(key, at);
    const last = list[list.length - 1];
    if (last !== undefined && at - last < this.config.minIntervalMs) {
      return { allowed: false, reason: "too_soon", retryAfterMs: this.config.minIntervalMs - (at - last) };
    }
    if (list.length >= this.config.maxPerWindow) {
      const oldest = list[0]!;
      return { allowed: false, reason: "window_full", retryAfterMs: oldest + this.config.windowMs - at };
    }
    return { allowed: true };
  }

  /** Counts an attempt (call once the attempt is actually going ahead). */
  record(key: string): void {
    const at = this.now();
    const list = this.recent(key, at);
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey !== undefined) this.hits.delete(oldestKey);
    }
  }

  /** Test helper. */
  reset(): void {
    this.hits.clear();
  }
}

export const USER_TEST_SEND_LIMIT: LimiterConfig = { minIntervalMs: 5_000, maxPerWindow: 6, windowMs: 10 * 60_000 };
export const DEVICE_TEST_SEND_LIMIT: LimiterConfig = { minIntervalMs: 0, maxPerWindow: 3, windowMs: 10 * 60_000 };
export const MAX_DEVICES_PER_TEST_SEND = 5;

export const testSendLimiters = {
  user: new SlidingWindowLimiter(USER_TEST_SEND_LIMIT),
  device: new SlidingWindowLimiter(DEVICE_TEST_SEND_LIMIT),
};

export function resetTestSendLimiters(): void {
  testSendLimiters.user.reset();
  testSendLimiters.device.reset();
}

/** "Lütfen 8 saniye sonra tekrar deneyin" / "…3 dakika sonra…" */
export function retryAfterPhrase(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return seconds < 90 ? `${seconds} saniye` : `${Math.ceil(seconds / 60)} dakika`;
}
