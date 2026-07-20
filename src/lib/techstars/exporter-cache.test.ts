import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createOptionsFingerprint,
  EXPORTER_CACHE_FILE,
  ExporterCacheError,
  ExporterCacheFingerprintError,
  openExporterCache,
  replaceCacheFileWithRetry,
  resetExporterCache,
} from "@/lib/techstars/exporter-cache";
import { serializeSourceWorkResultForCache } from "@/lib/techstars/source-cache-serialization";

function safeSource(url: string, status: "failed" | "retry_wait" = "failed") {
  return serializeSourceWorkResultForCache({
    candidate: { url },
    status,
    fetch: null,
    validation: null,
    extraction: null,
    linkedCandidates: [],
    error: status === "retry_wait" ? "Rate limited" : "Fetch failed",
  })!;
}

async function temporaryCache(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "fev-techstars-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, "techstars") };
}

test("options fingerprints are deterministic and reject secret-shaped options", () => {
  const first = createOptionsFingerprint({
    years: [2025, 2026],
    regions: ["europe", "north_america"],
    limits: { source: 2, company: 3 },
  });
  const reordered = createOptionsFingerprint({
    limits: { company: 3, source: 2 },
    regions: ["europe", "north_america"],
    years: [2025, 2026],
  });
  assert.equal(first, reordered);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.throws(
    () => createOptionsFingerprint({ searchApiKey: "do-not-cache" }),
    ExporterCacheError,
  );
});

test("cache writes versioned JSON and resumes interrupted or elapsed work", async (t) => {
  const { directory } = await temporaryCache(t);
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const fingerprint = createOptionsFingerprint({ years: [2025, 2026] });
  const cache = await openExporterCache({
    directory,
    optionsFingerprint: fingerprint,
    now: () => now,
  });
  cache.markProcessing("sources", "https://500.co/source");
  cache.markCompleted("companies", "example.com", {
    companyName: "Example",
    contentHash: "abc123",
  });
  cache.markRetry(
    "sources",
    "https://500.co/retry-elapsed",
    safeSource("https://500.co/retry-elapsed", "retry_wait"),
    "2026-01-01T00:00:05.000Z",
    "Rate limited",
  );
  cache.markRetry(
    "companies",
    "future.example",
    null,
    "2026-01-01T00:10:00.000Z",
    "Try later",
  );
  await cache.save();

  const raw = await readFile(join(directory, EXPORTER_CACHE_FILE), "utf8");
  const persisted = JSON.parse(raw) as { version: number; optionsFingerprint: string };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.optionsFingerprint, fingerprint);
  assert.doesNotMatch(raw, /<!doctype|<html|password|authorization/i);

  now += 10_000;
  const resumed = await openExporterCache({
    directory,
    optionsFingerprint: fingerprint,
    now: () => now,
  });
  assert.equal(resumed.get("sources", "https://500.co/source")?.status, "pending");
  assert.equal(
    resumed.get("sources", "https://500.co/retry-elapsed")?.status,
    "pending",
  );
  assert.equal(resumed.get("companies", "future.example")?.status, "retry_wait");
  assert.equal(resumed.get("companies", "example.com")?.status, "completed");
  assert.deepEqual(
    resumed.listUnfinished("sources").map(({ key }) => key).sort(),
    ["https://500.co/retry-elapsed", "https://500.co/source"],
  );
});

test("cache refuses option mismatch and unsafe cached content", async (t) => {
  const { directory } = await temporaryCache(t);
  const firstFingerprint = createOptionsFingerprint({ years: [2025] });
  await openExporterCache({ directory, optionsFingerprint: firstFingerprint });
  await assert.rejects(
    openExporterCache({
      directory,
      optionsFingerprint: createOptionsFingerprint({ years: [2026] }),
    }),
    ExporterCacheFingerprintError,
  );

  const cache = await openExporterCache({
    directory,
    optionsFingerprint: firstFingerprint,
  });
  assert.throws(
    () =>
      cache.markCompleted("sources", "unsafe-html", {
        html: "<html><body>not allowed</body></html>",
      }),
    ExporterCacheError,
  );
  assert.throws(
    () => cache.markCompleted("sources", "unsafe-secret", { sessionToken: "x" }),
    ExporterCacheError,
  );
  const infoSession = safeSource(
    "https://events.500.co/albertacceleratorinfosession",
  );
  cache.markCompleted(
    "sources",
    "https://events.500.co/albertacceleratorinfosession",
    infoSession,
  );
  await cache.save();
});

test("fresh reset removes only a marked exact cache directory", async (t) => {
  const { root, directory } = await temporaryCache(t);
  const fingerprint = createOptionsFingerprint({ years: [2025] });
  const cache = await openExporterCache({ directory, optionsFingerprint: fingerprint });
  cache.markCompleted("sources", "one", safeSource("https://500.co/one"));
  await cache.save();
  await writeFile(join(root, "outside-sentinel.txt"), "keep", "utf8");

  await assert.rejects(resetExporterCache(root), ExporterCacheError);
  assert.equal(await readFile(join(root, "outside-sentinel.txt"), "utf8"), "keep");

  const fresh = await openExporterCache({
    directory,
    optionsFingerprint: fingerprint,
    fresh: true,
  });
  assert.deepEqual(fresh.snapshot().sources, {});
  assert.equal(await readFile(join(root, "outside-sentinel.txt"), "utf8"), "keep");
});

test("atomic cache replacement retries transient Windows file locks", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await replaceCacheFileWithRetry(
    "state.tmp",
    "state.json",
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
      }
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
});

test("old unsafe source entries are migrated to the safe allowlisted schema", async (t) => {
  const { directory } = await temporaryCache(t);
  const fingerprint = createOptionsFingerprint({ years: [2025, 2026] });
  await openExporterCache({ directory, optionsFingerprint: fingerprint });
  const statePath = join(directory, EXPORTER_CACHE_FILE);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const url = "https://events.500.co/albertacceleratorinfosession";
  state.sources[url] = {
    status: "completed",
    attempts: 1,
    value: {
      candidate: { url },
      status: "failed",
      fetch: null,
      validation: null,
      extraction: null,
      linkedCandidates: [],
      error: "Legacy failure",
      html: "<html>legacy raw content</html>",
      pageText: "legacy complete page text",
      headers: { authorization: "Bearer secret" },
    },
    error: null,
    retryAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(statePath, JSON.stringify(state), "utf8");

  const migrated = await openExporterCache({
    directory,
    optionsFingerprint: fingerprint,
  });
  assert.equal(migrated.get("sources", url)?.status, "completed");
  const raw = await readFile(statePath, "utf8");
  assert.doesNotMatch(raw, /legacy raw content|legacy complete page text|authorization|Bearer secret/i);
  assert.match(raw, /albertacceleratorinfosession/);
});

test("a partially written invalid cache is ignored safely", async (t) => {
  const { directory } = await temporaryCache(t);
  const fingerprint = createOptionsFingerprint({ years: [2025] });
  await openExporterCache({ directory, optionsFingerprint: fingerprint });
  await writeFile(join(directory, EXPORTER_CACHE_FILE), "{partial", "utf8");
  const recovered = await openExporterCache({
    directory,
    optionsFingerprint: fingerprint,
  });
  assert.deepEqual(recovered.snapshot().sources, {});
});
