import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import readExcelFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";

import type {
  BlockedAntlerSource,
  FilteredAntlerCompany,
  FilteredAntlerDocument,
} from "@/lib/antler/types";
import { primaryParticipation } from "@/lib/antler/pipeline";
import { writeWorkbookAtomically } from "@/lib/masschallenge/atomic-workbook";
import { normalizeWorkbookCellText, parseWorkbook } from "@/lib/workbook-core";

export const ANTLER_READY_HEADERS = [
  "company_name", "website", "accelerator_batch", "accelerator_year", "country",
  "industry", "description", "founder_name", "founder_role", "linkedin_url",
  "founder_2", "linkedin_url_2", "founder_3", "linkedin_url_3",
  "founder_4", "linkedin_url_4", "source_url",
] as const;

const COMPANY_HEADERS = [
  "review_company_name", "review_website", "accelerator_batch", "accelerator_year",
  "location_classification", "canonical_country", "listed_location", "industry",
  "description", "location_evidence", "location_warnings", "company_pages_checked",
  "company_site_failures", "additional_source_urls", "source_url",
] as const;

const REVIEW_HEADERS = [
  ...COMPANY_HEADERS,
  "founder_candidates", "review_reasons", "founder_evidence",
] as const;

const BLOCKED_HEADERS = [
  "source_url", "source_title", "accelerator_year", "source_kind", "reason",
  "discovery_origin", "discovered_from", "manual_review_status",
] as const;

const EXCLUDED_HEADERS = [
  "record_type", "review_company_name", "review_website", "accelerator_year",
  "reason", "listed_location", "location_classification", "source_url",
  "source_title", "source_kind", "discovery_origin", "discovered_from",
  "manual_review_status",
] as const;

export type AntlerReadyRow = Record<(typeof ANTLER_READY_HEADERS)[number], string | number> & {
  accelerator_year: 2025 | 2026;
};

export type AntlerReviewRow = ReturnType<typeof toCompanyRow> & {
  founder_candidates?: string;
  review_reasons?: string;
  founder_evidence?: string;
};

export async function writeAntlerCompanyWorkbook(
  document: FilteredAntlerDocument,
  outputPath: string,
) {
  const eligible = document.companies.filter(isEligible);
  const unresolved = document.companies.filter((company) =>
    company.location_classification === "unresolved_location" ||
    company.location_classification === "conflicting_location",
  );
  const excluded = document.companies.filter((company) =>
    company.location_classification === "outside_target_region",
  );
  await writeWorkbook(outputPath, [
    makeSheet(COMPANY_HEADERS, eligible.map(toCompanyRow), "#166534"),
    makeSheet(COMPANY_HEADERS, unresolved.map(toCompanyRow), "#B45309"),
    makeSheet(COMPANY_HEADERS, excluded.map(toCompanyRow), "#B91C1C"),
    makeSheet(BLOCKED_HEADERS, document.blocked_sources, "#6B21A8"),
  ], ["Europe and North America", "Unresolved Location", "Excluded Geography", "Blocked Sources"]);
  return { eligible: eligible.length, unresolved: unresolved.length, excluded: excluded.length };
}

export async function writeAntlerFinalWorkbook(input: {
  outputPath: string;
  ready: AntlerReadyRow[];
  needsReview: AntlerReviewRow[];
  unresolved: AntlerReviewRow[];
  excluded: Array<Partial<Record<(typeof EXCLUDED_HEADERS)[number], unknown>>>;
  blocked: BlockedAntlerSource[];
}) {
  const excludedAndBlocked = [
    ...input.excluded,
    ...input.blocked.map((row) => ({ record_type: "blocked_source", ...row })),
  ];
  await writeWorkbook(input.outputPath, [
    makeSheet(ANTLER_READY_HEADERS, input.ready, "#1D4ED8"),
    makeSheet(REVIEW_HEADERS, input.needsReview, "#B45309"),
    makeSheet(REVIEW_HEADERS, input.unresolved, "#0369A1"),
    makeSheet(EXCLUDED_HEADERS, excludedAndBlocked, "#B91C1C"),
  ], ["Ready for Upload", "Needs Founder Review", "Unresolved Location", "Excluded - Blocked Sources"]);
  return validateAntlerWorkbook(input.outputPath, input.ready);
}

export async function validateAntlerWorkbook(
  outputPath: string,
  expectedReady: readonly AntlerReadyRow[],
) {
  const bytes = await readFile(outputPath);
  const sheets = await readExcelFile(bytes);
  const readySheet = sheets.find((sheet) => sheet.sheet === "Ready for Upload");
  if (!readySheet || !sameCells(readySheet.data[0] ?? [], ANTLER_READY_HEADERS)) {
    throw new Error("Generated Antler workbook has an unexpected Ready for Upload header contract.");
  }
  const rows = readySheet.data.slice(1).filter((row) => row.some((cell) => normalizeCell(cell)));
  if (rows.length !== expectedReady.length) {
    throw new Error(`Generated Antler workbook has ${rows.length} Ready rows; ${expectedReady.length} were expected.`);
  }
  expectedReady.forEach((expected, index) => {
    if (!sameCells(rows[index] ?? [], ANTLER_READY_HEADERS.map((header) => expected[header]))) {
      throw new Error(`Generated Antler workbook changed Ready row ${index + 2} during serialization.`);
    }
  });
  const file = new File([bytes], path.basename(outputPath), {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const parsed = await parseWorkbook(file, "antler");
  if (parsed.processedSheets.length !== 1 || parsed.processedSheets[0] !== "Ready for Upload") {
    throw new Error("Only Ready for Upload may be importable in the Antler workbook.");
  }
  const expectedFounders = expectedReady.reduce((count, row) => count +
    [row.founder_name, row.founder_2, row.founder_3, row.founder_4]
      .filter((value) => String(value).trim()).length, 0);
  if (parsed.invalidRows.length || parsed.founders.length !== expectedFounders) {
    throw new Error("Generated Antler Ready rows failed the shared upload parser contract.");
  }
  return { readyRows: rows.length, parsedFounders: parsed.founders.length };
}

export function toCompanyRow(company: FilteredAntlerCompany) {
  const primary = primaryParticipation(company.participation);
  return {
    review_company_name: company.company_name,
    review_website: company.website ?? "",
    accelerator_batch: primary.program ?? "",
    accelerator_year: primary.year,
    location_classification: company.location_classification,
    canonical_country: company.canonical_country ?? "",
    listed_location: company.listed_location ?? "",
    industry: company.industry ?? "",
    description: company.description ?? "",
    location_evidence: company.location_evidence.join(" | "),
    location_warnings: company.location_warnings.join(" | "),
    company_pages_checked: company.company_pages_checked.join(" | "),
    company_site_failures: company.company_site_failures.join(" | "),
    additional_source_urls: company.additional_source_urls.join(" | "),
    source_url: primary.source_url,
  };
}

function isEligible(company: FilteredAntlerCompany) {
  return company.location_classification === "europe" ||
    company.location_classification === "north_america";
}

async function writeWorkbook(
  outputPath: string,
  sheets: ReturnType<typeof makeSheet>[],
  names: string[],
) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeWorkbookAtomically(outputPath, (filePath) => writeXlsxFile(sheets, {
    sheets: names,
    columns: sheets.map((sheet) => (sheet[0] ?? []).map(() => ({ width: 28 }))),
    filePath,
    fontFamily: "Aptos",
    fontSize: 11,
    stickyRowsCount: 1,
    showGridLines: false,
  }));
}

function makeSheet<const T extends readonly string[]>(
  headers: T,
  rows: Array<Partial<Record<T[number], unknown>>>,
  color: string,
) {
  return [
    headers.map((header) => ({ value: header, type: String, fontWeight: "bold" as const,
      color: "#FFFFFF", backgroundColor: color, align: "left" as const, wrap: true })),
    ...rows.map((row, index) => headers.map((header) => {
      const raw = row[header as T[number]];
      const value = typeof raw === "number" ? raw : safeCell(raw);
      return { value, type: typeof value === "number" ? Number : String,
        align: typeof value === "number" ? "right" as const : "left" as const,
        wrap: true, backgroundColor: index % 2 ? "#F8FAFC" : "#FFFFFF" };
    })),
  ];
}

function safeCell(value: unknown) {
  const text = normalizeWorkbookCellText(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function normalizeCell(value: unknown) {
  return normalizeWorkbookCellText(value);
}

function sameCells(actual: readonly unknown[], expected: readonly unknown[]) {
  return actual.length === expected.length && actual.every((cell, index) =>
    normalizeCell(cell) === normalizeCell(expected[index]));
}
