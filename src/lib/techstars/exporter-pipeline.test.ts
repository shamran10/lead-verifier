import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFinalCompanies,
  mergeValidatedSourceExtractions,
} from "@/lib/techstars/exporter-pipeline";
import type {
  ExporterFinalCompany,
  ValidatedSourceExtraction,
} from "@/lib/techstars/exporter-pipeline-types";

test("deduplicates by domain and retains all official sources", () => {
  const merged = mergeValidatedSourceExtractions([
    sourceExtraction("https://techstars.com/content/a", "announcement", "https://example.com"),
    sourceExtraction("https://www.techstars.com/demo", "demo_day", "https://www.example.com/"),
  ]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.duplicates.length, 1);
  assert.deepEqual(merged.companies[0].supportingSourceUrls, [
    "https://techstars.com/content/a",
    "https://www.techstars.com/demo",
  ]);
  assert.equal(merged.companies[0].sourceKind, "announcement");
});

test("Stage 1 accepts an official company with a website and no founder", () => {
  const merged = mergeValidatedSourceExtractions([
    sourceExtraction("https://techstars.com/content/founder-later", "announcement", "https://founder-later.example"),
  ]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.companies[0].founders.length, 0);
  assert.equal(merged.companies[0].normalizedDomain, "example.com");
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

test("name-only records merge with a matching domain-backed company", () => {
  const domainBacked = sourceExtraction(
    "https://techstars.com/content/domain",
    "announcement",
    "https://example.com",
  );
  const nameOnly = sourceExtraction(
    "https://www.techstars.com/name-only",
    "demo_day",
    "https://example.com",
  );
  nameOnly.participants[0].website = null;
  nameOnly.participants[0].normalizedDomain = null;
  const merged = mergeValidatedSourceExtractions([domainBacked, nameOnly]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.duplicates.length, 1);
  assert.deepEqual(merged.companies[0].supportingSourceUrls, [
    "https://techstars.com/content/domain",
    "https://www.techstars.com/name-only",
  ]);
});

test("equal names with distinct domains remain separate in the global pipeline", () => {
  const first = sourceExtraction(
    "https://techstars.com/content/one",
    "announcement",
    "https://one.example",
  );
  first.participants[0].normalizedDomain = "one.example";
  const second = sourceExtraction(
    "https://www.techstars.com/two",
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
    "https://techstars.com/newsroom/update-2026",
    "announcement",
    "https://example.com",
  );
  extraction.participants = [
    ...extraction.participants,
    ...["14", "50+", "6 countries represented", "Startup Weekend", "Techstars Partners with Example to Launch a Program"].map(
      (companyName) => ({ ...extraction.participants[0], companyName }),
    ),
  ];
  const merged = mergeValidatedSourceExtractions([extraction]);
  assert.deepEqual(merged.companies.map((company) => company.companyName), ["Example"]);
  assert.equal(merged.duplicates.length, 5);
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
    acceleratorName: "Techstars",
    acceleratorBatch: "Batch",
    acceleratorYear: 2025,
    sourceUrl: "https://techstars.com/content/example",
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
    supportingSourceUrls: ["https://techstars.com/content/example"],
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
