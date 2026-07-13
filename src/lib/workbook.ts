import "server-only";

import readExcelFile, {
  type CellValue,
  type Row,
} from "read-excel-file/node";

import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";
import type {
  InvalidSourceRow,
  ParsedFounder,
  WorkbookParseResult,
} from "@/lib/types";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const HEADER_SCAN_LIMIT = 25;
const FOUNDER_COLUMNS = [
  { name: "founder_name", linkedin: "linkedin_url", role: "founder_role" },
  { name: "founder_2", linkedin: "linkedin_url_2" },
  { name: "founder_3", linkedin: "linkedin_url_3" },
  { name: "founder_4", linkedin: "linkedin_url_4" },
] as const;

function cellToString(value: CellValue | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value).trim();
}

function normalizeHeader(value: CellValue | null | undefined) {
  return cellToString(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findHeaderRow(rows: Row[]) {
  const scanLength = Math.min(rows.length, HEADER_SCAN_LIMIT);

  for (let rowIndex = 0; rowIndex < scanLength; rowIndex += 1) {
    const headers = rows[rowIndex].map(normalizeHeader);
    const hasFounder = FOUNDER_COLUMNS.some(({ name }) => headers.includes(name));

    if (
      headers.includes("company_name") &&
      headers.includes("website") &&
      hasFounder
    ) {
      return rowIndex;
    }
  }

  return -1;
}

function makeHeaderMap(row: Row) {
  const headers = new Map<string, number>();

  row.forEach((cell, index) => {
    const header = normalizeHeader(cell);
    if (header && !headers.has(header)) {
      headers.set(header, index);
    }
  });

  return headers;
}

function valueFor(row: Row, headers: Map<string, number>, key: string) {
  const index = headers.get(key);
  return index === undefined ? "" : cellToString(row[index]);
}

function hasAnyValue(row: Row) {
  return row.some((cell) => cellToString(cell) !== "");
}

function addInvalidRow(
  invalidRows: Map<string, InvalidSourceRow>,
  sourceSheetName: string,
  sourceRow: number,
  reason: string,
) {
  const key = `${sourceSheetName}\u0000${sourceRow}`;
  const existing = invalidRows.get(key);

  if (existing && !existing.reason.includes(reason)) {
    existing.reason = `${existing.reason}; ${reason}`;
    return;
  }

  if (!existing) {
    invalidRows.set(key, { sourceSheetName, sourceRow, reason });
  }
}

export function validateWorkbookFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Choose a valid .xlsx workbook.");
  }

  if (file.size === 0) {
    throw new Error("The selected workbook is empty.");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("The workbook exceeds the 15 MB upload limit.");
  }
}

export async function parseWorkbook(file: File): Promise<WorkbookParseResult> {
  validateWorkbookFile(file);

  let sheets;
  try {
    sheets = await readExcelFile(Buffer.from(await file.arrayBuffer()));
  } catch {
    throw new Error("The workbook could not be read. Confirm it is a valid .xlsx file.");
  }

  const founders: ParsedFounder[] = [];
  const invalidRows = new Map<string, InvalidSourceRow>();
  const processedSheets: string[] = [];
  const skippedSheets: string[] = [];

  for (const sheet of sheets) {
    const headerRowIndex = findHeaderRow(sheet.data);

    if (headerRowIndex === -1) {
      skippedSheets.push(sheet.sheet);
      continue;
    }

    processedSheets.push(sheet.sheet);
    const headers = makeHeaderMap(sheet.data[headerRowIndex]);

    for (
      let rowIndex = headerRowIndex + 1;
      rowIndex < sheet.data.length;
      rowIndex += 1
    ) {
      const row = sheet.data[rowIndex];
      if (!hasAnyValue(row)) {
        continue;
      }

      const sourceRow = rowIndex + 1;
      const companyName = valueFor(row, headers, "company_name");
      const website = valueFor(row, headers, "website");
      const normalizedDomain = normalizeDomain(website);
      const populatedFounders = FOUNDER_COLUMNS.map((columns) => ({
        name: valueFor(row, headers, columns.name),
        linkedinUrl: valueFor(row, headers, columns.linkedin),
        founderRole:
          "role" in columns ? valueFor(row, headers, columns.role) : "",
      })).filter((founder) => founder.name !== "");

      if (populatedFounders.length === 0) {
        addInvalidRow(
          invalidRows,
          sheet.sheet,
          sourceRow,
          "No founder name was provided",
        );
        continue;
      }

      for (const founder of populatedFounders) {
        if (!companyName) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Company name is missing",
          );
          continue;
        }

        if (!normalizedDomain) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Website does not contain a usable domain",
          );
          continue;
        }

        const normalizedName = normalizeFounderName(founder.name);
        if (!normalizedName) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            `Founder name “${founder.name}” has no usable Latin characters`,
          );
          continue;
        }

        const firstCandidateEmail = `${normalizedName.firstName}@${normalizedDomain}`;
        const lastCandidateEmail = normalizedName.lastName
          ? `${normalizedName.lastName}@${normalizedDomain}`
          : null;

        founders.push({
          sourceSheetName: sheet.sheet,
          sourceRow,
          companyName,
          website,
          normalizedDomain,
          ycBatch: valueFor(row, headers, "yc_batch") || null,
          industry: valueFor(row, headers, "industry") || null,
          description: valueFor(row, headers, "description") || null,
          country: valueFor(row, headers, "country") || null,
          founderName: founder.name,
          normalizedFounderName: normalizedName.normalizedFounderName,
          firstName: normalizedName.firstName,
          lastName: normalizedName.lastName,
          founderRole: founder.founderRole || null,
          linkedinUrl: founder.linkedinUrl || null,
          firstCandidateEmail,
          lastCandidateEmail:
            lastCandidateEmail === firstCandidateEmail
              ? null
              : lastCandidateEmail,
        });
      }
    }
  }

  if (processedSheets.length === 0) {
    throw new Error(
      "No sheet contains the required company_name, website, and founder headers.",
    );
  }

  return {
    founders,
    invalidRows: [...invalidRows.values()],
    processedSheets,
    skippedSheets,
  };
}
