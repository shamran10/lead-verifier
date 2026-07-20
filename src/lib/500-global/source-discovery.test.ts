import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverOfficialSourceCandidates,
  extractOfficialIndexCandidates,
} from "@/lib/500-global/source-discovery";

test("official index discovery keeps bounded 2025/2026 participant links", () => {
  const result = extractOfficialIndexCandidates(`
    <a href="https://events.500.co/batch-36-demo-day-2025">Batch 36 Demo Day 2025</a>
    <a href="https://500.co/apply/2025">Apply to our accelerator</a>
    <a href="https://arbitrary.example/2025-cohort">Third-party cohort</a>
    <a href="https://events.500.co/speakers-2025">Demo Day Speakers 2025</a>
  `, "https://500.co/events", [2025, 2026]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceKindHint, "demo_day");
  assert.equal(result[0].acceleratorYearHint, 2025);
});

test("catalog discovery still works when indexes and external search are unavailable", async () => {
  const result = await discoverOfficialSourceCandidates({
    years: [2025, 2026],
    indexUrls: ["https://500.co/content"],
    fetchIndex: async () => { throw new Error("offline"); },
    searchProvider: null,
  });
  assert.ok(result.candidates.length >= 5);
  assert.equal(result.indexUrlsFetched, 0);
  assert.match(result.warnings.join(" "), /External source discovery was unavailable/i);
});
