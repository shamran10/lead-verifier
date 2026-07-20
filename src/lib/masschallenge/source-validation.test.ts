import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateAndExtractParticipantSource } from "@/lib/masschallenge/source-validation";

const fixtures = path.join(process.cwd(), "src", "lib", "masschallenge", "fixtures");

async function fixture(name: string) {
  return readFile(path.join(fixtures, name), "utf8");
}

test("accepts an official MassChallenge cohort announcement", async () => {
  const result = validateAndExtractParticipantSource(
    await fixture("source-cohort-2026.html"),
    {
      url: "https://www.masschallenge.org/newsroom/meet-the-masschallenge-nyc-spring-2026-class",
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

test("extracts a large 103-company official roster without requiring websites", () => {
  const roster = Array.from(
    { length: 103 },
    (_, index) => `<li><h3>Swiss Startup ${index + 1}</h3><p>Selected participant in Lausanne, Switzerland.</p></li>`,
  ).join("");
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>MassChallenge Switzerland announces 2025 cohort</title></head><body><main>
      <h1>Meet the 103 startups selected for the MassChallenge Switzerland 2025 cohort</h1>
      <section><h2>Selected startups</h2><ul>${roster}</ul></section>
    </main></body></html>`,
    {
      url: "https://masschallenge.org/articles/masschallenge-switzerland-announces-103-startups-joining-2025-early-stage-accelerator-program/",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2025,
      acceleratorBatchHint: "MassChallenge Switzerland 2025",
      expectedApproximateCompanies: 103,
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants.length, 103);
  assert.equal(result.extraction?.participants.every((participant) => participant.website === null), true);
  assert.equal(result.extraction?.participants.every((participant) => participant.participantStatus === "selected"), true);
});

test("accepts a roster marker nested in an article header", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>MassChallenge UK 2025 cohort</title></head><body><main><article>
      <header><h1><strong>Meet the 2025 Cohort</strong></h1></header>
      <section><p><a href="https://nested.example"><strong>Nested Startup</strong></a> <strong>(United Kingdom):</strong> Selected company.</p></section>
    </article></main></body></html>`,
    {
      url: "https://masschallenge.org/news/nested-2025-cohort/",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2025,
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.companyName, "Nested Startup");
});

test("Elementor containers are not mistaken for mentor sections", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>MassChallenge Switzerland 2025 cohort</title></head><body><main>
      <section class="elementor-section elementor-element"><h1><strong>Meet the 2025 Cohort</strong></h1>
        <p><a href="https://element.example"><strong>Element Startup</strong></a> <strong>(Switzerland):</strong> Selected company.</p>
      </section>
    </main></body></html>`,
    {
      url: "https://masschallenge.org/news/elementor-2025-cohort/",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2025,
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.companyName, "Element Startup");
});

test("extracts 2025 finalists from an official table with partial metadata", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>2025 FinTech Challenge finalists</title></head><body><main>
      <h1>Meet the companies selected as 2025 MassChallenge FinTech finalists</h1>
      <table><thead><tr><th>Company</th><th>Location</th><th>Website</th></tr></thead><tbody>
        <tr><td>Ledger North</td><td>Boston, MA</td><td><a href="https://ledger.example">Website</a></td></tr>
        <tr><td>Open Vault</td><td>London, UK</td><td></td></tr>
      </tbody></table>
    </main></body></html>`,
    {
      url: "https://masschallenge.org/articles/meet-the-2025-fintech-challenge-finalists/",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2025,
      acceleratorBatchHint: "2025 FinTech Challenge",
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants.length, 2);
  assert.equal(result.extraction?.participants[1]?.website, null);
  assert.equal(result.extraction?.participants.every((participant) => participant.participantStatus === "finalist"), true);
});

test("extracts representative UK, FinTech, Air Force Labs, and Constellation rosters", async () => {
  for (const sample of [
    {
      fixture: "source-uk-2025.html",
      url: "https://masschallenge.org/news/masschallenge-uk-2025-cohort/",
      batch: "MassChallenge UK 2025",
      strategies: ["participant_list"] as const,
      status: "selected",
    },
    {
      fixture: "source-fintech-2025.html",
      url: "https://masschallenge.org/news/the-future-of-fintech-starts-here-meet-the-2025-masschallenge-fintech-cohort/",
      batch: "MassChallenge FinTech 2025",
      strategies: ["participant_list"] as const,
      status: "selected",
    },
    {
      fixture: "source-air-force-labs-2025.html",
      url: "https://masschallenge.org/news/masschallenge-announces-2025-air-force-labs-cohort-bridging-commercial-innovation-and-defense/",
      batch: "MassChallenge Air Force Labs 2025",
      strategies: ["company_cards"] as const,
      status: "participant",
    },
    {
      fixture: "source-constellation-finalists-2025.html",
      url: "https://masschallenge.org/news/masschallenge-and-smore-works-announce-top-10-finalists-for-the-2025-constellation-program/",
      batch: "MassChallenge Constellation 2025",
      strategies: ["participant_list"] as const,
      status: "finalist",
    },
  ]) {
    const result = validateAndExtractParticipantSource(
      await fixture(sample.fixture),
      {
        url: sample.url,
        sourceKindHint: "cohort_roster",
        acceleratorYearHint: 2025,
        acceleratorBatchHint: sample.batch,
        strategyHints: [...sample.strategies],
        origin: "catalog",
      },
    );
    assert.equal(result.validation.accepted, true, sample.fixture);
    assert.equal(result.extraction?.participants.length, 2, sample.fixture);
    assert.equal(
      result.extraction?.participants.every((participant) => participant.participantStatus === sample.status),
      true,
      sample.fixture,
    );
  }
});

test("an official 2026 application-only fixture produces zero companies", async () => {
  const result = validateAndExtractParticipantSource(
    await fixture("source-application-only-2026.html"),
    {
      url: "https://masschallenge.org/programs/apply-2026/",
      sourceKindHint: "cohort_roster",
      acceleratorYearHint: 2026,
      strategyHints: ["participant_list", "company_cards"],
      origin: "official_index",
    },
  );
  assert.equal(result.validation.accepted, false);
  assert.equal(result.extraction, null);
});

test("extracts a portfolio update grouped by accelerator", async () => {
  const result = validateAndExtractParticipantSource(
    await fixture("source-portfolio-update-2025.html"),
    {
      url: "https://www.masschallenge.org/blog/impact/masschallenge-update-june-2025",
      sourceKindHint: "announcement",
      acceleratorYearHint: 2025,
      acceleratorBatchHint: "MassChallenge London Accelerator",
      strategyHints: ["participant_list"],
      origin: "catalog",
    },
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants.length, 2);
});

test("extracts participant-level city/state and Canadian province locations from descriptions", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>MassChallenge 2026 Cohort</title></head><body><main>
      <h2>Meet the companies selected for the MassChallenge 2026 cohort</h2>
      <ul>
        <li><h3>State Company</h3><a href="https://state.example">Website</a><p>(New York, NY): Builds useful software.</p></li>
        <li><h3>Province Company</h3><a href="https://province.example">Website</a><p>(Calgary, AB, Canada): Builds useful hardware.</p></li>
      </ul>
    </main></body></html>`,
    {
      url: "https://www.masschallenge.org/newsroom/example-2026-cohort",
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
    ["source-general-program.html", "https://www.masschallenge.org/accelerators/london"],
    ["source-historical-portfolio.html", "https://www.masschallenge.org/portfolio"],
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
    ["Applications Are Now Open for MassChallenge Spring 2026 Accelerator Programs", "https://www.masschallenge.org/blog/program-news/applications-open-2026"],
    ["Three New Cities Join as MassChallenge Startup Community Partners", "https://www.masschallenge.org/blog/impact/three-new-cities"],
    ["USC and MassChallenge Announce Their Third Startup Weekend", "https://www.masschallenge.org/newsroom/usc-startup-weekend"],
  ]) {
    const result = validateAndExtractParticipantSource(
      `<!doctype html><html><head><title>${title}</title></head><body><main>
        <h2>MassChallenge companies and programs</h2>
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
      url: "https://www.masschallenge.org/newsroom/example",
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
    `<!doctype html><html><head><title>Meet the MassChallenge Paris September 2024 Class</title></head><body><main>
      <h2>Meet the 2024 cohort companies</h2><ul><li><h3>Old Company</h3><a href="https://old.example">Website</a></li></ul>
    </main></body></html>`,
    {
      url: "https://www.masschallenge.org/newsroom/paris-class",
      acceleratorYearHint: 2026,
      sourceKindHint: "cohort_roster",
      strategyHints: ["participant_list"],
      origin: "search_provider",
    },
  );
  assert.equal(result.validation.accepted, false);
  assert.ok(result.validation.reasonCodes.includes("year_conflict"));
});

test("does not infer 2026 from unrelated current-page recommendations", () => {
  const result = validateAndExtractParticipantSource(
    `<!doctype html><html><head><title>Bridge to MassChallenge Japan Announces Top Startups</title></head><body><main>
      <h1>Meet the startups selected for the program</h1>
      <ul><li><h3>Historical Company</h3></li></ul>
      <aside>Related: Healthcare Life Sciences cohort 2026</aside>
    </main></body></html>`,
    {
      url: "https://masschallenge.org/news/bridge-to-masschallenge-japan-announces-top-startups",
      sourceKindHint: "cohort_roster",
      strategyHints: ["participant_list"],
      origin: "official_index",
    },
  );
  assert.equal(result.validation.accepted, false);
  assert.ok(result.validation.reasonCodes.includes("unsupported_year"));
});
