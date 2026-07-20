import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import readExcelFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";

import { parseWorkbook } from "@/lib/workbook-core";
import { writeWorkbookAtomically } from "@/lib/masschallenge/atomic-workbook";

export const READY_HEADERS = [
  "company_name",
  "website",
  "accelerator_batch",
  "accelerator_year",
  "country",
  "industry",
  "description",
  "founder_name",
  "founder_role",
  "linkedin_url",
  "founder_2",
  "linkedin_url_2",
  "founder_3",
  "linkedin_url_3",
  "founder_4",
  "linkedin_url_4",
  "source_url",
] as const;

const REVIEW_HEADERS = [
  "record_type",
  "review_company_name",
  "review_website",
  "accelerator_batch",
  "accelerator_year",
  "country",
  "industry",
  "description",
  "founder_candidates",
  "review_reasons",
  "location_evidence",
  "founder_evidence",
  "additional_source_urls",
  "source_kind",
  "extraction_strategy",
  "source_url",
  "coverage_warning",
] as const;

const EXCLUDED_BLOCKED_HEADERS = [
  "record_type",
  "company_name",
  "website",
  "accelerator_year",
  "reason",
  "listed_country",
  "normalized_region",
  "source_url",
  "source_title",
  "source_kind",
  "extraction_strategy",
  "discovery_origin",
  "discovered_from",
  "manual_review_status",
] as const;

export const BLOCKED_SOURCE_HEADERS = [
  "source_url",
  "source_title",
  "accelerator_year",
  "source_kind",
  "reason",
  "discovery_origin",
  "discovered_from",
  "manual_review_status",
] as const;

export type ReadyForUploadRow = {
  company_name: string;
  website: string;
  accelerator_batch: string;
  accelerator_year: 2025 | 2026;
  country: string;
  industry: string;
  description: string;
  founder_name: string;
  founder_role: string;
  linkedin_url: string;
  founder_2: string;
  linkedin_url_2: string;
  founder_3: string;
  linkedin_url_3: string;
  founder_4: string;
  linkedin_url_4: string;
  source_url: string;
};

export type NeedsReviewExportRow = {
  record_type?: "company" | "coverage_warning" | "source_warning";
  review_company_name?: string;
  review_website?: string;
  accelerator_batch?: string;
  accelerator_year?: number | string;
  country?: string;
  industry?: string;
  description?: string;
  founder_candidates?: string;
  review_reasons?: string;
  location_evidence?: string;
  founder_evidence?: string;
  additional_source_urls?: string;
  source_kind?: string;
  extraction_strategy?: string;
  source_url?: string;
  coverage_warning?: string;
};

export type ExcludedExportRow = {
  record_type?: "company" | "duplicate" | "source";
  excluded_company_name?: string;
  excluded_website?: string;
  accelerator_year?: number | string;
  exclusion_reason?: string;
  listed_country?: string;
  normalized_region?: string;
  source_url?: string;
  source_kind?: string;
  extraction_strategy?: string;
};

export type BlockedSourceExportRow = {
  source_url: string;
  source_title: string;
  accelerator_year: number | string;
  source_kind: string;
  reason: string;
  discovery_origin: string;
  discovered_from: string;
  manual_review_status: string;
};

export type ExportWorkbookInput = {
  outputPath: string;
  ready: ReadyForUploadRow[];
  needsReview: NeedsReviewExportRow[];
  unresolvedLocation: NeedsReviewExportRow[];
  excluded: ExcludedExportRow[];
  blockedSources: BlockedSourceExportRow[];
  coverageWarnings: string[];
};

export type WorkbookCompatibilityResult = {
  processedSheets: string[];
  skippedSheets: string[];
  parsedFounders: number;
  readyRows: number;
};

export async function writeMassChallengeWorkbook(
  input: ExportWorkbookInput,
): Promise<WorkbookCompatibilityResult> {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  const reviewRows = [
    ...input.needsReview,
    ...input.coverageWarnings.map((warning) => ({
      record_type: "coverage_warning" as const,
      coverage_warning: warning,
    })),
  ];
  const excludedAndBlockedRows = [
    ...input.excluded.map((row) => ({
      record_type: row.record_type ?? "company",
      company_name: row.excluded_company_name,
      website: row.excluded_website,
      accelerator_year: row.accelerator_year,
      reason: row.exclusion_reason,
      listed_country: row.listed_country,
      normalized_region: row.normalized_region,
      source_url: row.source_url,
      source_kind: row.source_kind,
      extraction_strategy: row.extraction_strategy,
    })),
    ...input.blockedSources.map((row) => ({
      record_type: "blocked_source",
      accelerator_year: row.accelerator_year,
      reason: row.reason,
      source_url: row.source_url,
      source_title: row.source_title,
      source_kind: row.source_kind,
      discovery_origin: row.discovery_origin,
      discovered_from: row.discovered_from,
      manual_review_status: row.manual_review_status,
    })),
  ];
  const sheets = [
    makeSheet(READY_HEADERS, input.ready, "#1D4ED8"),
    makeSheet(REVIEW_HEADERS, reviewRows, "#B45309"),
    makeSheet(REVIEW_HEADERS, input.unresolvedLocation, "#0369A1"),
    makeSheet(EXCLUDED_BLOCKED_HEADERS, excludedAndBlockedRows, "#B91C1C"),
  ];
  await writeWorkbookAtomically(input.outputPath, (filePath) =>
    writeXlsxFile(sheets, {
      // Excel forbids `/` in worksheet names, so the requested combined
      // "Excluded / Blocked Sources" sheet uses a hyphen.
      sheets: ["Ready for Upload", "Needs Founder Review", "Unresolved Location", "Excluded - Blocked Sources"],
      columns: [
        widths([28, 30, 24, 16, 20, 22, 48, 24, 22, 34, 24, 34, 24, 34, 24, 34, 52]),
        widths([18, 28, 30, 24, 16, 20, 22, 48, 42, 52, 52, 52, 52, 22, 24, 52, 64]),
        widths([18, 28, 30, 24, 16, 20, 22, 48, 42, 52, 52, 52, 52, 22, 24, 52, 64]),
        widths([18, 28, 30, 16, 56, 22, 20, 52, 38, 22, 24, 20, 58, 24]),
      ],
      filePath,
      fontFamily: "Aptos",
      fontSize: 11,
      stickyRowsCount: 1,
      showGridLines: false,
    }),
  );
  return validateMassChallengeWorkbook(input.outputPath, input.ready);
}

export async function validateMassChallengeWorkbook(
  outputPath: string,
  expectedReady: number | readonly ReadyForUploadRow[],
): Promise<WorkbookCompatibilityResult> {
  const bytes = await readFile(outputPath);
  const workbook = await readExcelFile(bytes);
  const readySheet = workbook.find((sheet) => sheet.sheet === "Ready for Upload");
  if (!readySheet || !sameCells(readySheet.data[0] ?? [], READY_HEADERS)) {
    throw new Error("Generated workbook has an unexpected Ready for Upload header contract.");
  }
  const readyDataRows = readySheet.data
    .slice(1)
    .filter((row) => row.some((value) => value !== null && String(value).trim() !== ""));
  const expectedReadyRows =
    typeof expectedReady === "number" ? expectedReady : expectedReady.length;
  if (readyDataRows.length !== expectedReadyRows) {
    throw new Error(
      `Generated workbook has ${readyDataRows.length} Ready rows; ${expectedReadyRows} were expected.`,
    );
  }
  if (typeof expectedReady !== "number") {
    expectedReady.forEach((expected, index) => {
      const expectedCells = READY_HEADERS.map((header) => {
        const value = expected[header];
        return typeof value === "number" ? value : safeCell(value);
      });
      if (!sameCells(readyDataRows[index] ?? [], expectedCells)) {
        throw new Error(
          `Generated workbook changed Ready row ${index + 2} during serialization.`,
        );
      }
    });
  }
  const file = new File(
    [bytes],
    path.basename(outputPath),
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  );
  const parsed = await parseWorkbook(file, "masschallenge");
  if (
    parsed.processedSheets.length !== 1 ||
    parsed.processedSheets[0] !== "Ready for Upload"
  ) {
    throw new Error("Generated workbook is unsafe: only Ready for Upload may be importable.");
  }
  if (
    !parsed.skippedSheets.includes("Needs Founder Review") ||
    !parsed.skippedSheets.includes("Unresolved Location") ||
    !parsed.skippedSheets.includes("Excluded - Blocked Sources")
  ) {
    throw new Error("Generated diagnostic worksheets were not safely excluded by the upload parser.");
  }
  if (parsed.invalidRows.length) {
    throw new Error(`Generated Ready for Upload worksheet has ${parsed.invalidRows.length} invalid rows.`);
  }
  if (typeof expectedReady !== "number") {
    const expectedFounders = expectedReady.reduce(
      (total, row) =>
        total +
        [row.founder_name, row.founder_2, row.founder_3, row.founder_4]
          .filter((founder) => founder.trim() !== "").length,
      0,
    );
    if (parsed.founders.length !== expectedFounders) {
      throw new Error(
        `Generated workbook parsed ${parsed.founders.length} founders; ${expectedFounders} were expected.`,
      );
    }
  }
  return {
    processedSheets: parsed.processedSheets,
    skippedSheets: parsed.skippedSheets,
    parsedFounders: parsed.founders.length,
    readyRows: expectedReadyRows,
  };
}

function sameCells(
  actual: readonly unknown[],
  expected: readonly unknown[],
) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => normalizeCell(value) === normalizeCell(expected[index]))
  );
}

function normalizeCell(value: unknown) {
  return value === null || value === undefined
    ? ""
    : decodeXmlEntities(String(value));
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function makeSheet<const T extends readonly string[]>(
  headers: T,
  rows: Array<Partial<Record<T[number], unknown>>>,
  headerColor: string,
) {
  return [
    headers.map((header) => ({
      value: header,
      type: String,
      fontWeight: "bold" as const,
      color: "#FFFFFF",
      backgroundColor: headerColor,
      align: "left" as const,
      wrap: true,
      height: 28,
    })),
    ...rows.map((row, rowIndex) =>
      headers.map((header) => {
        const raw = row[header as T[number]];
        const value = typeof raw === "number" ? raw : safeCell(raw);
        return {
          value,
          type: typeof value === "number" ? Number : String,
          align: typeof value === "number" ? "right" as const : "left" as const,
          wrap: true,
          backgroundColor: rowIndex % 2 ? "#F8FAFC" : "#FFFFFF",
          borderColor: "#E2E8F0",
          borderStyle: "thin" as const,
        };
      }),
    ),
  ];
}

function safeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function widths(values: number[]) {
  return values.map((width) => ({ width }));
}
