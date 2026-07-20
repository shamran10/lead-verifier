export const MINIMUM_SAME_HOST_SPACING_MS = 2_000;
export const MAX_EXPORTER_CONCURRENCY = 3;

type Clock = () => number;
type Sleep = (milliseconds: number) => Promise<void>;

type SameHostRateLimiterOptions = {
  minimumSpacingMs?: number;
  now?: Clock;
  sleep?: Sleep;
};

type HostState = {
  nextAllowedAt: number;
  tail: Promise<void>;
};

export class SameHostRateLimiter {
  readonly minimumSpacingMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleep;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: SameHostRateLimiterOptions = {}) {
    const requested = options.minimumSpacingMs ?? MINIMUM_SAME_HOST_SPACING_MS;
    if (!Number.isFinite(requested) || requested < 0) {
      throw new RangeError("The same-host spacing must be a non-negative number.");
    }
    this.minimumSpacingMs = Math.max(
      MINIMUM_SAME_HOST_SPACING_MS,
      Math.ceil(requested),
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Waits for this host's turn and returns the scheduled start time in epoch ms. */
  async wait(input: string | URL) {
    const key = normalizeHostKey(input);
    const state = this.getHostState(key);
    const previous = state.tail;
    let release: () => void = () => undefined;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const current = this.now();
      const scheduledAt = Math.max(current, state.nextAllowedAt);
      const delay = scheduledAt - current;
      if (delay > 0) await this.sleep(delay);
      state.nextAllowedAt = scheduledAt + this.minimumSpacingMs;
      return scheduledAt;
    } finally {
      release();
    }
  }

  /** Defers new work for a host until an absolute epoch timestamp. */
  deferUntil(input: string | URL, timestamp: number | Date | string) {
    const parsed =
      typeof timestamp === "number"
        ? timestamp
        : timestamp instanceof Date
          ? timestamp.getTime()
          : Date.parse(timestamp);
    if (!Number.isFinite(parsed)) {
      throw new RangeError("The retry cooldown timestamp is invalid.");
    }
    const state = this.getHostState(normalizeHostKey(input));
    state.nextAllowedAt = Math.max(state.nextAllowedAt, parsed);
    return state.nextAllowedAt;
  }

  /** Applies an HTTP Retry-After value and returns the absolute retry time. */
  applyRetryAfter(input: string | URL, retryAfter: string | null | undefined) {
    const retryAt = parseRetryAfter(retryAfter, this.now());
    this.deferUntil(input, retryAt);
    return retryAt;
  }

  nextAllowedAt(input: string | URL) {
    return this.hosts.get(normalizeHostKey(input))?.nextAllowedAt ?? 0;
  }

  private getHostState(key: string) {
    const existing = this.hosts.get(key);
    if (existing) return existing;
    const state: HostState = {
      nextAllowedAt: 0,
      tail: Promise.resolve(),
    };
    this.hosts.set(key, state);
    return state;
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
  concurrency = 2,
): Promise<R[]> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_EXPORTER_CONCURRENCY
  ) {
    throw new RangeError(
      `Exporter concurrency must be between 1 and ${MAX_EXPORTER_CONCURRENCY}.`,
    );
  }
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
) {
  const raw = value?.trim() ?? "";
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  const requested = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1_000
    : Date.parse(raw);
  const fallback = now + 15 * 60 * 1_000;
  return Number.isFinite(requested)
    ? Math.min(
        Math.max(Math.ceil(requested), now + 30_000),
        now + 24 * 60 * 60 * 1_000,
      )
    : fallback;
}

export function normalizeHostKey(input: string | URL) {
  let url: URL;
  try {
    url =
      input instanceof URL
        ? input
        : new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new TypeError("A valid host or URL is required for rate limiting.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!hostname) {
    throw new TypeError("A valid host or URL is required for rate limiting.");
  }
  return hostname;
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
