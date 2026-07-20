import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFinalCompanies,
  mergeValidatedSourceExtractions,
} from "@/lib/masschallenge/exporter-pipeline";
import type {
  ExporterFinalCompany,
  ValidatedSourceExtraction,
} from "@/lib/masschallenge/exporter-pipeline-types";

test("deduplicates by domain and retains all official sources", () => {
  const merged = mergeValidatedSourceExtractions([
    sourceExtraction("https://masschallenge.org/content/a", "announcement", "https://example.com"),
    sourceExtraction("https://www.masschallenge.org/demo", "demo_day", "https://www.example.com/"),
  ]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.duplicates.length, 1);
  assert.deepEqual(merged.companies[0].supportingSourceUrls, [
    "https://masschallenge.org/content/a",
    "https://www.masschallenge.org/demo",
  ]);
  assert.equal(merged.companies[0].programAssociations?.length, 2);
  assert.equal(merged.companies[0].sourceKind, "announcement");
});

test("Stage 1 accepts an official company with neither website nor founder", () => {
  const extraction = sourceExtraction(
    "https://masschallenge.org/content/founder-later",
    "announcement",
    "https://founder-later.example",
  );
  extraction.participants[0].website = null;
  extraction.participants[0].normalizedDomain = null;
  const merged = mergeValidatedSourceExtractions([
    extraction,
  ]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.companies[0].founders.length, 0);
  assert.equal(merged.companies[0].normalizedDomain, null);
  assert.equal(merged.companies[0].programAssociations?.[0]?.participantStatus, "selected");
});

test("classifies confirmed outside geography as excluded", () => {
  const result = classifyFinalCompanies([
    finalCompany({
      headquartersCountry: "Japan",
      headquartersIso2: "JP",
      headquartersRegion: null,
      locationStatus: "confirmed",
    }),
  ], [2025, 2026], ["europe", "north_america"]);
  assert.equal(result.excluded.length, 1);
  assert.match(result.excluded[0].exclusionReason, /outside Europe and North America/i);
});

test("keeps missing headquarters under needs review", () => {
  const result = classifyFinalCompanies([
    finalCompany({
      headquartersCountry: null,
      headquartersIso2: null,
      headquartersRegion: null,
      locationStatus: "missing",
    }),
  ], [2025], ["europe", "north_america"]);
  assert.equal(result.needsReview.length, 1);
  assert.match(result.needsReview[0].reviewReasons.join(" "), /location is missing/i);
});

test("confirmed target location and active founder is ready", () => {
  const result = classifyFinalCompanies([
    finalCompany({}),
  ], [2025], ["europe", "north_america"]);
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0].company_name, "Example");
  assert.equal(result.ready[0].founder_name, "Ada Example");
});

test("LinkedIn is optional when the active founder is otherwise evidence-backed", () => {
  const company = finalCompany({});
  company.founders[0].linkedinUrl = null;
  const result = classifyFinalCompanies(
    [company],
    [2025],
    ["europe", "north_america"],
  );
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0].linkedin_url, "");
});

test("missing founder remains in Needs Founder Review", () => {
  const result = classifyFinalCompanies(
    [finalCompany({ founders: [] })],
    [2025],
    ["europe", "north_america"],
  );
  assert.equal(result.ready.length, 0);
  assert.match(result.needsReview[0].reviewReasons.join(" "), /active founder/i);
});

test("name-only records merge with a matching domain-backed company", () => {
  const domainBacked = sourceExtraction(
    "https://masschallenge.org/content/domain",
    "announcement",
    "https://example.com",
  );
  const nameOnly = sourceExtraction(
    "https://www.masschallenge.org/name-only",
    "demo_day",
    "https://example.com",
  );
  nameOnly.participants[0].website = null;
  nameOnly.participants[0].normalizedDomain = null;
  const merged = mergeValidatedSourceExtractions([domainBacked, nameOnly]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.duplicates.length, 1);
  assert.deepEqual(merged.companies[0].supportingSourceUrls, [
    "https://masschallenge.org/content/domain",
    "https://www.masschallenge.org/name-only",
  ]);
});

test("equal names with distinct domains remain separate in the global pipeline", () => {
  const first = sourceExtraction(
    "https://masschallenge.org/content/one",
    "announcement",
    "https://one.example",
  );
  first.participants[0].normalizedDomain = "one.example";
  const second = sourceExtraction(
    "https://www.masschallenge.org/two",
    "demo_day",
    "https://two.example",
  );
  second.participants[0].normalizedDomain = "two.example";
  const merged = mergeValidatedSourceExtractions([first, second]);
  assert.equal(merged.companies.length, 2);
  assert.equal(merged.duplicates.length, 0);
});

test("conflicting founder active-status evidence cannot become Ready", () => {
  const company = finalCompany({
    founders: [
      {
        founderName: "Ada Example",
        founderRole: "Founder & CEO",
        linkedinUrl: null,
        sourceUrl: "https://example.com/about",
        confidence: 0.9,
        activeStatus: "confirmed",
      },
      {
        founderName: "Ada Example",
        founderRole: "Former Founder",
        linkedinUrl: null,
        sourceUrl: "https://example.com/team",
        confidence: 0.95,
        activeStatus: "former",
      },
    ],
  });
  const result = classifyFinalCompanies(
    [company],
    [2025],
    ["europe", "north_america"],
  );
  assert.equal(result.ready.length, 0);
  assert.match(result.needsReview[0].reviewReasons.join(" "), /active founder/i);
});

test("filters statistics, program labels, and newsroom article titles from companies", () => {
  const extraction = sourceExtraction(
    "https://masschallenge.org/newsroom/update-2026",
    "announcement",
    "https://example.com",
  );
  extraction.participants = [
    ...extraction.participants,
    ...["14", "50+", "6 countries represented", "Startup Weekend", "MassChallenge Partners with Example to Launch a Program", "Program Partners", "Speakers", "Sponsors", "Fraud Detection & Prevention", "Key Dates", "Published on: May 29, 2026", "Wearable ultrasound technology delivering continuous cardiac imaging", "Solutions that have a validated product for scaling", "Switzerland"].map(
      (companyName) => ({ ...extraction.participants[0], companyName }),
    ),
  ];
  const merged = mergeValidatedSourceExtractions([extraction]);
  assert.deepEqual(merged.companies.map((company) => company.companyName), ["Example"]);
  assert.equal(merged.duplicates.length, 14);
});

function sourceExtraction(
  url: string,
  sourceKind: "announcement" | "demo_day",
  website: string,
): ValidatedSourceExtraction {
  return {
    source: {
      url,
      originalUrl: url,
      hostname: new URL(url).hostname,
      sourceKind,
      acceleratorYear: 2025,
      acceleratorBatch: "Batch",
      pageTitle: "Companies",
      publishedDate: "2025-01-01",
      strategies: ["company_cards"],
      participantAssertions: ["Meet the companies"],
      expectedMinimumCompanies: 1,
      expectedApproximateCompanies: null,
      warnings: [],
    },
    participants: [{
      companyName: "Example",
      website,
      normalizedDomain: "example.com",
      listedCountry: "United States",
      industry: sourceKind === "announcement" ? "Software" : null,
      description: null,
      founders: [],
      sourceUrl: url,
      extractionStrategy: "company_cards",
      evidenceSnippet: "Example company",
      warnings: [],
      participantStatus: "selected",
    }],
    warnings: [],
  };
}

function finalCompany(
  overrides: Partial<ExporterFinalCompany>,
): ExporterFinalCompany {
  return {
    companyName: "Example",
    website: "https://example.com",
    normalizedDomain: "example.com",
    acceleratorName: "MassChallenge",
    acceleratorBatch: "Batch",
    acceleratorYear: 2025,
    sourceUrl: "https://masschallenge.org/content/example",
    sourceKind: "announcement",
    officialMembershipStatus: "confirmed",
    listedCountry: "United States",
    listedCountryEvidence: "company_specific",
    industry: "Software",
    description: null,
    founders: [{
      founderName: "Ada Example",
      founderRole: "Founder & CEO",
      linkedinUrl: "https://www.linkedin.com/in/ada-example",
      sourceUrl: "https://example.com/about",
      confidence: 0.9,
      activeStatus: "confirmed",
    }],
    supportingSourceUrls: ["https://masschallenge.org/content/example"],
    extractionStrategies: ["participant_list"],
    warnings: [],
    evidenceStrength: 95,
    headquartersCountry: "United States",
    headquartersIso2: "US",
    headquartersRegion: "north_america",
    locationStatus: "confirmed",
    locationEvidence: ["Company is based in the United States."],
    founderEvidence: ["Ada Example — Founder & CEO"],
    reviewReasons: [],
    ...overrides,
  };
}
