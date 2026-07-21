import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { antlerOptionsFingerprint, openAntlerCache } from "@/lib/antler/cache";
import { createAntlerHostLimiter, parseArguments } from "../../../scripts/find-antler-leads";

test("Antler limiter schedules requests at least ten seconds apart", async () => {
  let clock = 0;
  const delays: number[] = [];
  const limiter = createAntlerHostLimiter({ now: () => clock, sleep: async (milliseconds) => {
    delays.push(milliseconds); clock += milliseconds;
  } });
  await limiter.wait("https://www.antler.co/portfolio");
  await limiter.wait("https://antler.co/blog/showcase");
  assert.deepEqual(delays, [10_000]);
  assert.equal(limiter.minimumSpacingMs, 10_000);
  assert.throws(() => parseArguments(["--host-spacing-ms=9999"]), /cannot be lower/);
});

test("robots-blocked paths are rejected without a request", async () => {
  const { isRobotsDisallowedAntlerPath } = await import("@/lib/antler/source-policy");
  for (const url of [
    "https://www.antler.co/portfolio/company/example",
    "https://www.antler.co/portfolio/showcase/example",
    "https://www.antler.co/showcase-proxy/example",
    "https://www.antler.co/new-portfolio-companies/example",
  ]) assert.equal(isRobotsDisallowedAntlerPath(url), true);
  assert.equal(isRobotsDisallowedAntlerPath("https://www.antler.co/portfolio?x=1"), false);
});

test("cache resumes completed work, recovers processing work, and fresh resets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-antler-cache-"));
  const directory = path.join(root, ".cache", "antler", "discover");
  const fingerprint = antlerOptionsFingerprint({ stage: "discover" });
  let cache = await openAntlerCache({ directory, fingerprint, fresh: false });
  cache.set("sources", "one", "completed", { safe: true });
  cache.markProcessing("sources", "two");
  await cache.save();
  cache = await openAntlerCache({ directory, fingerprint, fresh: false });
  assert.deepEqual(cache.get("sources", "one")?.value, { safe: true });
  assert.equal(cache.get("sources", "two")?.status, "pending");
  cache = await openAntlerCache({ directory, fingerprint, fresh: true });
  assert.equal(cache.get("sources", "one"), undefined);
  const contents = await readFile(path.join(directory, "state.json"), "utf8");
  assert.equal(contents.includes("raw_html"), false);
});

test("cache serialization refuses raw HTML and secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-antler-cache-"));
  const directory = path.join(root, ".cache", "antler", "filter");
  const cache = await openAntlerCache({ directory, fingerprint: antlerOptionsFingerprint({ stage: "filter" }), fresh: false });
  assert.throws(() => cache.set("companies", "unsafe", "completed", { raw_html: "<html>secret</html>" }), /unsafe|raw html/i);
  assert.throws(() => cache.set("companies", "unsafe", "completed", { api_key: "secret" }), /unsafe/i);
});
