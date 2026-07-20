import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSourceSearchQueries,
  discoverOfficialSourceCandidates,
  extractOfficialIndexCandidates,
} from "@/lib/masschallenge/source-discovery";

test("builds year-specific cohort, class, company, accelerator, program, and regional searches", () => {
  const queries = buildSourceSearchQueries([2025, 2026]);
  for (const phrase of [
    "2025 cohort", "2025 class", "2025 companies", "2025 accelerator",
    "2026 cohort", "2026 class", "2026 companies", "2026 accelerator",
  ]) {
    assert.equal(queries.some((query) => query.includes(`\"${phrase}\"`)), true, phrase);
  }
  assert.equal(queries.every((query) => query.includes("site:masschallenge.org")), true);
  assert.equal(queries.some((query) => /NYC.*London.*Boston/i.test(query)), true);
  assert.equal(new Set(queries).size, queries.length);
});

test("official index discovery keeps MassChallenge cohort links and rejects unrelated roles", () => {
  const result = extractOfficialIndexCandidates(`
    <a href="/newsroom/meet-the-masschallenge-nyc-spring-2026-class">Meet the MassChallenge NYC Spring 2026 class</a>
    <a href="/accelerators/apply-2026">Apply to the accelerator</a>
    <a href="https://arbitrary.example/2026-cohort">Third-party cohort</a>
    <a href="/events/speakers-2026">Demo Day speakers 2026</a>
    <a href="/newsroom/meet-the-2024-class">Meet the MassChallenge 2024 class</a>
  `, "https://www.masschallenge.org/newsroom", [2025, 2026]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.acceleratorYearHint, 2026);
  assert.equal(result[0]?.sourceKindHint, "cohort_roster");
});

test("discovery drops explicitly stale-year URLs before they consume the source cap", async () => {
  const result = await discoverOfficialSourceCandidates({
    years: [2025, 2026],
    indexUrls: ["https://www.masschallenge.org/newsroom"],
    fetchIndex: async () => ({
      finalUrl: "https://www.masschallenge.org/newsroom",
      html: `<a href="/newsroom/meet-the-2024-class">Meet the 2024 class</a>
        <a href="/newsroom/meet-the-2025-class">Meet the 2025 class</a>`,
    }),
    searchProvider: null,
  });
  assert.equal(result.candidates.some((candidate) => candidate.url.includes("2024")), false);
  assert.equal(result.candidates.some((candidate) => candidate.url.includes("2025-class")), true);
});

test("maintained discovery survives unavailable indexes and Brave Search", async () => {
  const result = await discoverOfficialSourceCandidates({
    years: [2025, 2026],
    indexUrls: ["https://www.masschallenge.org/newsroom"],
    fetchIndex: async () => { throw new Error("offline"); },
    searchProvider: null,
  });
  assert.ok(result.candidates.length >= 3);
  assert.equal(result.indexUrlsFetched, 0);
  assert.match(result.warnings.join(" "), /External source discovery was unavailable/i);
});
