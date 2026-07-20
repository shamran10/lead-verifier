import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateAndExtractParticipantSource } from "@/lib/techstars/source-validation";

const fixtures = path.join(process.cwd(), "src", "lib", "techstars", "fixtures");

async function fixture(name: string) {
  return readFile(path.join(fixtures, name), "utf8");
}

test("accepts an official Techstars cohort announcement", async () => {
  const result = validateAndExtractParticipantSource(
    await fixture("source-cohort-2026.html"),
    {
      url: "https://www.techstars.com/newsroom/meet-the-techstars-nyc-spring-2026-class",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2026,
      strategyHints: ["company_cards"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants.length, 2);
  assert.equal(result.extraction?.source.acceleratorYear, 2026);
});

test("extracts a portfolio update grouped by accelerator", async () => {
  const result = validateAndExtractParticipantSource(
    await fixture("source-portfolio-update-2025.html"),
    {
      url: "https://www.techstars.com/blog/impact/techstars-update-june-2025",
      sourceKindHint: "announcement",
      acceleratorYearHint: 2025,
      acceleratorBatchHint: "Techstars London Accelerator",
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants.length, 2);
});

test("extracts participant-level city/state and Canadian province locations from descriptions", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>Techstars 2026 Cohort</title></head><body><main>
      <h2>Meet the companies selected for the Techstars 2026 cohort</h2>
      <ul>
        <li><h3>State Company</h3><a href="https://state.example">Website</a><p>(New York, NY): Builds useful software.</p></li>
        <li><h3>Province Company</h3><a href="https://province.example">Website</a><p>(Calgary, AB, Canada): Builds useful hardware.</p></li>
      </ul>
    </main></body></html>`,
    {
      url: "https://www.techstars.com/newsroom/example-2026-cohort",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2026,
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((company) => company.listedCountry),
    ["New York, NY", "Calgary, AB, Canada"],
  );
  assert.equal(
    result.extraction?.participants.every(
      (company) => company.listedCountryEvidence === "company_specific",
    ),
    true,
  );
});

test("generic accelerator and historical portfolio pages produce zero companies", async () => {
  for (const [name, url] of [
    ["source-general-program.html", "https://www.techstars.com/accelerators/london"],
    ["source-historical-portfolio.html", "https://www.techstars.com/portfolio"],
  ] as const) {
    const result = validateAndExtractParticipantSource(await fixture(name), {
      url,
      acceleratorYearHint: 2025,
      origin: "official_index",
    });
    assert.equal(result.validation.accepted, false);
    assert.equal(result.extraction, null);
  }
});

test("application and partnership announcements cannot become cohort rosters", () => {
  for (const [title, url] of [
    ["Applications Are Now Open for Techstars Spring 2026 Accelerator Programs", "https://www.techstars.com/blog/program-news/applications-open-2026"],
    ["Three New Cities Join as Techstars Startup Community Partners", "https://www.techstars.com/blog/impact/three-new-cities"],
    ["USC and Techstars Announce Their Third Startup Weekend", "https://www.techstars.com/newsroom/usc-startup-weekend"],
  ]) {
    const result = validateAndExtractParticipantSource(
      `<!doctype html><html><head><title>${title}</title></head><body><main>
        <h2>Techstars companies and programs</h2>
        <ul><li><h3>Boston Accelerator</h3><a href="https://example.com">Website</a></li></ul>
      </main></body></html>`,
      {
        url,
        acceleratorYearHint: 2026,
        sourceKindHint: "announcement",
        strategyHints: ["participant_list"],
        origin: "official_index",
      },
    );
    assert.equal(result.validation.accepted, false, title);
    assert.equal(result.extraction, null, title);
  }
});

test("rejects the wrong cohort year even when publication timing differs", async () => {
  const result = validateAndExtractParticipantSource(
    (await fixture("source-cohort-2026.html")).replace("<title>", '<meta property="article:published_time" content="2025-12-01"><title>'),
    {
      url: "https://www.techstars.com/newsroom/example",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2026,
      strategyHints: ["company_cards"],
      origin: "catalog",
    },
    { targetYears: [2025] },
  );
  assert.equal(result.validation.accepted, false);
  assert.ok(result.validation.reasonCodes.includes("unsupported_year"));
});

test("rejects a stale 2024 class page mislabeled by a 2026 search hint", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>Meet the Techstars Paris September 2024 Class</title></head><body><main>
      <h2>Meet the 2024 cohort companies</h2><ul><li><h3>Old Company</h3><a href="https://old.example">Website</a></li></ul>
    </main></body></html>`,
    {
      url: "https://www.techstars.com/newsroom/paris-class",
      acceleratorYearHint: 2026,
      sourceKindHint: "cohort_roster",
      strategyHints: ["participant_list"],
      origin: "search_provider",
    },
  );
  assert.equal(result.validation.accepted, false);
  assert.ok(result.validation.reasonCodes.includes("year_conflict"));
});
