import { mkdir } from "node:fs/promises";
import path from "node:path";

import writeXlsxFile from "write-excel-file/node";

import type {
  FilteredTechstarsCompany,
  FilteredTechstarsDocument,
} from "@/lib/techstars/staged-workflow";
import { writeWorkbookAtomically } from "@/lib/techstars/atomic-workbook";
const COMPANY_HEADERS = [
  "review_company_name",
  "review_website",
  "accelerator_batch",
  "accelerator_year",
  "location_classification",
  "canonical_country",
  "listed_location",
  "roster_location_confidence",
  "roster_location_source_url",
  "industry",
  "description",
  "location_evidence",
  "location_warnings",
  "source_kind",
  "additional_source_urls",
  "source_url",
] as const;

const BLOCKED_HEADERS = [
  "source_url",
  "source_title",
  "accelerator_year",
  "source_kind",
  "reason",
  "discovery_origin",
  "discovered_from",
  "manual_review_status",
] as const;

export async function writeTechstarsCompanyWorkbook(
  document: FilteredTechstarsDocument,
  outputPath: string,
) {
  const target = document.companies.filter((company) =>
    company.location_classification === "europe" ||
    company.location_classification === "north_america",
  );
  const unresolved = document.companies.filter((company) =>
    company.location_classification === "unresolved_location" ||
    company.location_classification === "conflicting_location",
  );
  const excluded = document.companies.filter(
    (company) => company.location_classification === "outside_target_region",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeWorkbookAtomically(outputPath, (filePath) =>
    writeXlsxFile(
      [
        makeSheet(COMPANY_HEADERS, target.map(toCompanyRow), "#166534"),
        makeSheet(COMPANY_HEADERS, unresolved.map(toCompanyRow), "#B45309"),
        makeSheet(COMPANY_HEADERS, excluded.map(toCompanyRow), "#B91C1C"),
        makeSheet(BLOCKED_HEADERS, document.blocked_sources, "#6B21A8"),
      ],
      {
        sheets: [
          "Europe and North America",
          "Unresolved Location",
          "Excluded Geography",
          "Blocked Sources",
        ],
        columns: [
          widths(), widths(), widths(),
          [58, 38, 16, 22, 58, 20, 58, 24].map((width) => ({ width })),
        ],
        filePath,
        fontFamily: "Aptos",
        fontSize: 11,
        stickyRowsCount: 1,
        showGridLines: false,
      },
    ),
  );
  return {
    target: target.length,
    unresolved: unresolved.length,
    excluded: excluded.length,
    blocked: document.blocked_sources.length,
  };
}

function toCompanyRow(company: FilteredTechstarsCompany) {
  return {
    review_company_name: company.company_name,
    review_website: company.website,
    accelerator_batch: company.accelerator_batch ?? "",
    accelerator_year: company.accelerator_year,
    location_classification: company.location_classification,
    canonical_country: company.canonical_country ?? "",
    listed_location: company.listed_location ?? "",
    roster_location_confidence: company.roster_location_evidence?.confidence ?? "",
    roster_location_source_url: company.roster_location_evidence?.source_url ?? "",
    industry: company.industry ?? "",
    description: company.description ?? "",
    location_evidence: company.location_evidence.join(" | "),
    location_warnings: company.location_warnings.join(" | "),
    source_kind: company.source_kind,
    additional_source_urls: company.additional_source_urls.join(" | "),
    source_url: company.source_url,
  };
}

function makeSheet<const T extends readonly string[]>(
  headers: T,
  rows: Array<Partial<Record<T[number], unknown>>>,
  color: string,
) {
  return [
    headers.map((header) => ({
      value: header,
      type: String,
      fontWeight: "bold" as const,
      color: "#FFFFFF",
      backgroundColor: color,
      align: "left" as const,
      wrap: true,
      height: 28,
    })),
    ...rows.map((row, index) => headers.map((header) => {
      const raw = row[header as T[number]];
      const value = typeof raw === "number" ? raw : safeCell(raw);
      return {
        value,
        type: typeof value === "number" ? Number : String,
        align: typeof value === "number" ? "right" as const : "left" as const,
        wrap: true,
        backgroundColor: index % 2 ? "#F8FAFC" : "#FFFFFF",
        borderColor: "#E2E8F0",
        borderStyle: "thin" as const,
      };
    })),
  ];
}

function safeCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function widths() {
  return [28, 30, 24, 16, 24, 22, 24, 18, 58, 22, 48, 58, 52, 22, 58, 58]
    .map((width) => ({ width }));
}
