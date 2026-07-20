import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  outputFilename,
  parseArguments,
  processSourceQueue,
} from "../../../scripts/find-techstars-leads";
import {
  createOptionsFingerprint,
  openExporterCache,
} from "@/lib/techstars/exporter-cache";
import { DiscoveryFetchError } from "@/lib/500-global/safe-fetch";
import { serializeSourceWorkResultForCache } from "@/lib/techstars/source-cache-serialization";

test("standalone CLI defaults and output filename match the upload workflow", () => {
  const options = parseArguments([])!;
  assert.equal(options.stage, "all");
  assert.deepEqual(options.years, [2025, 2026]);
  assert.deepEqual(options.regions, ["europe", "north_america"]);
  assert.equal(options.sourceConcurrency, 1);
  assert.equal(options.companyConcurrency, 2);
  assert.equal(options.hostSpacingMs, 2_000);
  assert.equal(
    outputFilename(options),
    "Techstars_2025_2026_Europe_North_America.xlsx",
  );
});

test("standalone CLI accepts safe subsets and conservative limits", () => {
  const options = parseArguments([
    "--years=2026",
    "--stage=filter",
    "--regions=north_america",
    "--resume",
    "--source-concurrency=2",
    "--company-concurrency=3",
    "--host-spacing-ms=2500",
  ])!;
  assert.deepEqual(options.years, [2026]);
  assert.equal(options.stage, "filter");
  assert.deepEqual(options.regions, ["north_america"]);
  assert.equal(options.resume, true);
  assert.equal(options.sourceConcurrency, 2);
  assert.equal(options.companyConcurrency, 3);
  assert.equal(options.hostSpacingMs, 2_500);
  assert.equal(
    outputFilename(options),
    "Techstars_2026_North_America.xlsx",
  );
});

test("standalone CLI rejects unsafe or contradictory arguments", () => {
  for (const values of [
    ["--years="],
    ["--stage=unknown"],
    ["--years=2024"],
    ["--regions=asia"],
    ["--source-concurrency=3"],
    ["--company-concurrency=4"],
    ["--host-spacing-ms=1999"],
    ["--resume", "--fresh"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArguments(values));
  }
});

test("help parsing exits before cache, network, or workbook orchestration", () => {
  const original = console.log;
  const messages: string[] = [];
  console.log = (value?: unknown) => messages.push(String(value ?? ""));
  try {
    assert.equal(parseArguments(["--help"]), null);
  } finally {
    console.log = original;
  }
  assert.match(messages.join("\n"), /does not write to Supabase/i);
});

test("one source cache failure does not stop later source processing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fev-500-global-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await openExporterCache({
    directory: join(root, "cache"),
    optionsFingerprint: createOptionsFingerprint({ test: "source-isolation" }),
  });
  const candidates = [
    { url: "https://techstars.com/content/first-2026" },
    { url: "https://techstars.com/content/second-2026" },
  ];
  const results = await processSourceQueue(
    candidates,
    parseArguments([])!,
    cache,
    {},
    {
      fetchSource: async (url) => ({
        finalUrl: url,
        html: "<html><title>Techstars 2026</title></html>",
        status: 200,
        contentType: "text/html",
        contentHash: "abc123",
        etag: null,
        lastModified: null,
        fetchedAt: "2026-01-01T00:00:00.000Z",
        robotsCheckedAt: "2026-01-01T00:00:00.000Z",
        redirectCount: 0,
      }),
      validateSource: () => ({
        validation: {
          disposition: "rejected",
          accepted: false,
          source: null,
          reasonCodes: ["no_participant_assertion"],
          warnings: [],
          probes: [],
        },
        extraction: null,
      }),
      extractLinkedCandidates: () => [],
      serializeResult: (result, now) => {
        if (result && typeof result === "object" && "candidate" in result) {
          const candidate = (result as { candidate?: { url?: string } }).candidate;
          if (candidate?.url?.includes("first")) throw new Error("synthetic cache failure");
        }
        return serializeSourceWorkResultForCache(result, now);
      },
    },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, "cache_error");
  assert.equal(results[1]?.status, "rejected");
  assert.match(results[0]?.error ?? "", /cache_error/i);
  assert.equal(cache.get("sources", candidates[1]!.url)?.status, "completed");
});

test("robots-blocked sources are recorded once and skipped safely", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fev-500-global-robots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = await openExporterCache({
    directory: join(root, "cache"),
    optionsFingerprint: createOptionsFingerprint({ test: "robots" }),
  });
  let fetches = 0;
  const url = "https://www.techstars.com/blocked";
  const results = await processSourceQueue(
    [{ url }, { url }],
    parseArguments([])!,
    cache,
    {},
    {
      fetchSource: async () => {
        fetches += 1;
        throw new DiscoveryFetchError(
          "robots.txt disallows this path",
          "blocked",
          null,
          null,
          "DiscoveryFetchError",
          "robots_disallowed",
          false,
          "2026-01-01T00:00:00.000Z",
        );
      },
    },
  );
  assert.equal(fetches, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, "robots_blocked");
  assert.equal(cache.get("sources", url)?.status, "completed");
});
