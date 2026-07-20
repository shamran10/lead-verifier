import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import readExcelFile from "read-excel-file/node";

import {
  readDiscoveredDocument,
  readFilteredDocument,
  MASSCHALLENGE_STAGE_SCHEMA_VERSION,
  writeStageDocument,
  type DiscoveredMassChallengeDocument,
  type FilteredMassChallengeDocument,
} from "@/lib/masschallenge/staged-workflow";
import { writeMassChallengeCompanyWorkbook } from "@/lib/masschallenge/stage-workbook";

const discoveredCompany = {
  company_name: "Example Company",
  website: "https://example.com",
  normalized_domain: "example.com",
  accelerator_batch: "MassChallenge 2025",
  accelerator_year: 2025 as const,
  program_name: "MassChallenge 2025",
  listed_location: "United States",
  listed_location_evidence: "company_specific" as const,
  canonical_country: "United States",
  country_iso2: "US",
  roster_location_evidence: {
    authority: "masschallenge_official" as const,
    evidence_type: "participant_listing" as const,
    listed_location: "United States",
    canonical_country: "United States",
    country_iso2: "US",
    region: "north_america" as const,
    confidence: 0.98,
    source_url: "https://masschallenge.org/content/example",
  },
  industry: "Software",
  description: null,
  source_url: "https://masschallenge.org/content/example",
  additional_source_urls: [],
  program_associations: [{
    program: "MassChallenge 2025",
    year: 2025 as const,
    source_url: "https://masschallenge.org/content/example",
    participant_status: "selected" as const,
  }],
  source_kind: "announcement" as const,
  discovery_status: "official_confirmed" as const,
  discovery_warnings: [],
};

test("Stage 1 and Stage 2 documents persist a resumable founder-free boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-masschallenge-stages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const discoveredPath = path.join(root, "discovered-companies.json");
  const filteredPath = path.join(root, "filtered-companies.json");
  const discovered: DiscoveredMassChallengeDocument = {
    schema_version: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
    stage: "discover",
    generated_at: "2026-07-20T00:00:00.000Z",
    years: [2025, 2026],
    companies: [discoveredCompany],
    source_summary: {
      sources_discovered: 1,
      sources_validated: 1,
      sources_processed: 1,
      official_companies_extracted: 1,
      unique_companies: 1,
      duplicates_merged: 0,
      sources_blocked: 0,
      roster_locations_recognized: 1,
    },
    blocked_sources: [],
    source_warnings: [],
    excluded_sources: [],
    duplicate_audit: [],
    coverage_warnings: [],
  };
  await writeStageDocument(discoveredPath, discovered);
  const resumedDiscovery = await readDiscoveredDocument(discoveredPath);
  assert.equal(resumedDiscovery.companies.length, 1);
  assert.equal(JSON.stringify(resumedDiscovery).includes("founder"), false);

  const filtered: FilteredMassChallengeDocument = {
    schema_version: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
    stage: "filter",
    generated_at: "2026-07-20T01:00:00.000Z",
    years: [2025, 2026],
    regions: ["europe", "north_america"],
    companies: [{
      ...discoveredCompany,
      canonical_country: "United States",
      country_iso2: "US",
      location_classification: "north_america",
      location_evidence: ["Company-owned contact page"],
      location_warnings: [],
      company_pages_checked: ["https://example.com/contact"],
      company_site_failures: [],
    }],
    blocked_sources: [],
    source_warnings: [],
    excluded_sources: [],
    duplicate_audit: [],
    coverage_warnings: [],
  };
  await writeStageDocument(filteredPath, filtered);
  const resumedFilter = await readFilteredDocument(filteredPath);
  assert.equal(resumedFilter.companies[0]?.location_classification, "north_america");
  assert.equal(JSON.stringify(resumedFilter).includes("founder"), false);
});

test("Stage 2 workbook retains eligible companies and separates unresolved and outside geography", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-masschallenge-filter-xlsx-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const company = (name: string, classification: "north_america" | "unresolved_location" | "outside_target_region") => ({
    ...discoveredCompany,
    company_name: name,
    normalized_domain: `${name.toLowerCase().replace(/\s/g, "-")}.example`,
    canonical_country: classification === "north_america" ? "Canada" : classification === "outside_target_region" ? "Japan" : null,
    country_iso2: classification === "north_america" ? "CA" : classification === "outside_target_region" ? "JP" : null,
    location_classification: classification,
    location_evidence: [],
    location_warnings: [],
    company_pages_checked: [],
    company_site_failures: [],
  });
  const document: FilteredMassChallengeDocument = {
    schema_version: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
    stage: "filter",
    generated_at: "2026-07-20T00:00:00.000Z",
    years: [2025, 2026],
    regions: ["europe", "north_america"],
    companies: [company("Eligible", "north_america"), company("Unknown", "unresolved_location"), company("Outside", "outside_target_region")],
    blocked_sources: [], source_warnings: [], excluded_sources: [], duplicate_audit: [], coverage_warnings: [],
  };
  const outputPath = path.join(root, "companies.xlsx");
  const counts = await writeMassChallengeCompanyWorkbook(document, outputPath);
  assert.deepEqual(counts, { target: 1, unresolved: 1, excluded: 1, blocked: 0 });
  const sheets = await readExcelFile(await readFile(outputPath));
  assert.deepEqual(sheets.map((sheet) => sheet.sheet), [
    "Europe and North America", "Unresolved Location", "Excluded Geography", "Blocked Sources",
  ]);
  assert.equal(sheets[0]?.data[1]?.[0], "Eligible");
  assert.equal(sheets[1]?.data[1]?.[0], "Unknown");
  assert.equal(sheets[2]?.data[1]?.[0], "Outside");
  assert.equal(sheets.flatMap((sheet) => sheet.data[0] ?? []).some((cell) => /founder/i.test(String(cell))), false);
});

test("stage documents reject raw HTML", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-masschallenge-safe-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    writeStageDocument(path.join(root, "unsafe.json"), { description: "<!doctype html><html></html>" }),
    /Raw HTML/i,
  );
});
