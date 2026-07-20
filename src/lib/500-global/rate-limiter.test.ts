import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";

import {
  mapWithConcurrency,
  MINIMUM_SAME_HOST_SPACING_MS,
  normalizeHostKey,
  parseRetryAfter,
  SameHostRateLimiter,
} from "@/lib/500-global/rate-limiter";

test("same-host requests are spaced by at least two seconds", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const limiter = new SameHostRateLimiter({
    minimumSpacingMs: 1,
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  const first = await limiter.wait("https://www.example.com/");
  const second = await limiter.wait("https://example.com/about");
  const third = await limiter.wait("example.com");

  assert.equal(limiter.minimumSpacingMs, MINIMUM_SAME_HOST_SPACING_MS);
  assert.equal(second - first, 2_000);
  assert.equal(third - second, 2_000);
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.equal(normalizeHostKey("https://www.EXAMPLE.com./x"), "example.com");
});

test("concurrent waits for one host are serialized while hosts have independent gates", async () => {
  let now = 10_000;
  const limiter = new SameHostRateLimiter({
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  const [first, second, third] = await Promise.all([
    limiter.wait("https://one.example/path-a"),
    limiter.wait("https://one.example/path-b"),
    limiter.wait("https://two.example/path"),
  ]);
  assert.ok(second - first >= 2_000);
  assert.ok(third >= 10_000);
});

test("Retry-After creates a bounded host cooldown", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const limiter = new SameHostRateLimiter({
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  await limiter.wait("https://rate.example/page");
  const retryAt = limiter.applyRetryAfter("rate.example", "120");
  assert.equal(retryAt, 121_000);
  const scheduled = await limiter.wait("https://www.rate.example/next");
  assert.equal(scheduled, retryAt);
  assert.equal(sleeps.at(-1), 120_000);

  assert.equal(parseRetryAfter("0", 1_000), 31_000);
  assert.equal(parseRetryAfter("invalid", 1_000), 901_000);
  assert.equal(parseRetryAfter("999999", 1_000), 86_401_000);
});

test("mapWithConcurrency preserves order and enforces conservative concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const output = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6],
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await waitForImmediate();
      active -= 1;
      return value * 10;
    },
    3,
  );

  assert.deepEqual(output, [10, 20, 30, 40, 50, 60]);
  assert.equal(maximumActive, 3);
  await assert.rejects(
    mapWithConcurrency([1], async (value) => value, 4),
    RangeError,
  );
});
