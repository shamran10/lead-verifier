import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import readExcelFile from "read-excel-file/node";
import { parseWorkbook } from "@/lib/workbook-core";

import {
  READY_HEADERS,
  writeMassChallengeWorkbook,
} from "@/lib/masschallenge/xlsx-export";

const EXPECTED_READY_HEADERS = [
  "company_name", "website", "accelerator_batch", "accelerator_year",
  "country", "industry", "description", "founder_name", "founder_role",
  "linkedin_url", "founder_2", "linkedin_url_2", "founder_3",
  "linkedin_url_3", "founder_4", "linkedin_url_4", "source_url",
] as const;

test("generated workbook is accepted by the upload parser and diagnostics are skipped", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fev-500-xlsx-"));
  const outputPath = path.join(directory, "leads.xlsx");
  const result = await writeMassChallengeWorkbook({
    outputPath,
    ready: [{
      company_name: "Example Company",
      website: "https://example.com",
      accelerator_batch: "Example Batch",
      accelerator_year: 2025,
      country: "United States",
      industry: "Software",
      description: "Example",
      founder_name: "Ada Example",
      founder_role: "Founder & CEO",
      linkedin_url: "https://www.linkedin.com/in/ada-example",
      founder_2: "",
      linkedin_url_2: "",
      founder_3: "",
      linkedin_url_3: "",
      founder_4: "",
      linkedin_url_4: "",
      source_url: "https://masschallenge.org/content/example",
    }],
    needsReview: [{
      record_type: "company",
      review_company_name: "Review Company",
      founder_candidates: "Unconfirmed Person",
      review_reasons: "Founder role is uncertain.",
    }],
    unresolvedLocation: [{
      record_type: "company",
      review_company_name: "Location Review Company",
      review_reasons: "Company headquarters could not be confirmed.",
    }],
    excluded: [{
      record_type: "company",
      excluded_company_name: "Outside Company",
      exclusion_reason: "Outside selected regions.",
      listed_country: "Japan",
    }],
    blockedSources: [{
      source_url: "https://www.masschallenge.org/blocked",
      source_title: "Blocked Demo Day",
      accelerator_year: 2025,
      source_kind: "demo_day",
      reason: "robots.txt disallows automated access.",
      discovery_origin: "catalog",
      discovered_from: "",
      manual_review_status: "Review manually",
    }],
    coverageWarnings: [
      "All matching companies found from verified official sources currently discovered and supported by the exporter.",
    ],
  });
  assert.deepEqual(result.processedSheets, ["Ready for Upload"]);
  assert.deepEqual(result.skippedSheets.sort(), ["Excluded - Blocked Sources", "Needs Founder Review", "Unresolved Location"]);
  assert.equal(result.parsedFounders, 1);

  const bytes = await readFile(outputPath);
  const sheets = await readExcelFile(bytes);
  const ready = sheets.find((sheet) => sheet.sheet === "Ready for Upload");
  assert.deepEqual([...READY_HEADERS], [...EXPECTED_READY_HEADERS]);
  assert.deepEqual(ready?.data[0], [...EXPECTED_READY_HEADERS]);
  const needsReview = sheets.find((sheet) => sheet.sheet === "Needs Founder Review");
  assert.equal(
    needsReview?.data.some((row) =>
      row.some((cell) =>
        String(cell ?? "").includes(
          "All matching companies found from verified official sources currently discovered and supported by the exporter.",
        ),
      ),
    ),
    true,
  );
  const unresolved = sheets.find((sheet) => sheet.sheet === "Unresolved Location");
  assert.equal(unresolved?.data[1]?.[1], "Location Review Company");
  const excludedAndBlocked = sheets.find((sheet) => sheet.sheet === "Excluded - Blocked Sources");
  assert.equal(excludedAndBlocked?.data[2]?.[8], "Blocked Demo Day");
  const parsed = await parseWorkbook(
    new File([bytes], "masschallenge.xlsx"),
    "masschallenge",
  );
  assert.equal(parsed.founders[0]?.acceleratorName, "MassChallenge");
  assert.equal(parsed.founders[0]?.acceleratorBatch, "Example Batch");
});

test("header-only Ready sheet remains diagnostic-safe when no rows qualify", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fev-500-xlsx-empty-"));
  const outputPath = path.join(directory, "empty.xlsx");
  const result = await writeMassChallengeWorkbook({
    outputPath,
    ready: [],
    needsReview: [{
      record_type: "company",
      review_company_name: "Unresolved Company",
      review_reasons: "Founder missing.",
    }],
    unresolvedLocation: [],
    excluded: [],
    blockedSources: [],
    coverageWarnings: ["No Ready for Upload rows were produced."],
  });
  assert.deepEqual(result.processedSheets, ["Ready for Upload"]);
  assert.deepEqual(result.skippedSheets.sort(), ["Excluded - Blocked Sources", "Needs Founder Review", "Unresolved Location"]);
  assert.equal(result.readyRows, 0);
  assert.equal(result.parsedFounders, 0);
});

test("all four founder slots and exact company cells survive XLSX serialization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fev-500-xlsx-four-"));
  const outputPath = path.join(directory, "four-founders.xlsx");
  const ready = [{
    company_name: "Four Founder Company",
    website: "https://four.example",
    accelerator_batch: "Batch Four",
    accelerator_year: 2026 as const,
    country: "Canada",
    industry: "Software",
    description: "Exact metadata",
    founder_name: "Ada One",
    founder_role: "Founder & CEO",
    linkedin_url: "https://www.linkedin.com/in/ada-one",
    founder_2: "Bea Two",
    linkedin_url_2: "https://www.linkedin.com/in/bea-two",
    founder_3: "Cal Three",
    linkedin_url_3: "",
    founder_4: "Dee Four",
    linkedin_url_4: "",
    source_url: "https://masschallenge.org/content/four-founder-company",
  }];
  const result = await writeMassChallengeWorkbook({
    outputPath,
    ready,
    needsReview: [],
    unresolvedLocation: [],
    excluded: [],
    blockedSources: [],
    coverageWarnings: [],
  });
  assert.equal(result.readyRows, 1);
  assert.equal(result.parsedFounders, 4);
  const sheets = await readExcelFile(await readFile(outputPath));
  const row = sheets.find((sheet) => sheet.sheet === "Ready for Upload")?.data[1];
  assert.deepEqual(
    row?.map(decodeTestXmlEntities),
    EXPECTED_READY_HEADERS.map((header) => ready[0][header]),
  );
});

function decodeTestXmlEntities(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "string"
    ? value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : value;
}
