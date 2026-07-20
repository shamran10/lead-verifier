import readExcelFile, {
  type CellValue,
  type Row,
} from "read-excel-file/node";

import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";
import {
  isRecognizedCountry,
  resolveEligibleCountry,
} from "@/lib/geography";
import type {
  InvalidSourceRow,
  ParsedFounder,
  SourceType,
  WorkbookParseResult,
} from "@/lib/types";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const HEADER_SCAN_LIMIT = 25;
const APPROVED_500_GLOBAL_SOURCE_HOSTS = ["500.co"] as const;
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

function findHeaderRow(rows: Row[], sourceType: SourceType) {
  const scanLength = Math.min(rows.length, HEADER_SCAN_LIMIT);

  for (let rowIndex = 0; rowIndex < scanLength; rowIndex += 1) {
    const headers = rows[rowIndex].map(normalizeHeader);
    const hasFounder = FOUNDER_COLUMNS.some(({ name }) => headers.includes(name));

    const hasCommonHeaders =
      headers.includes("company_name") &&
      headers.includes("website") &&
      hasFounder;
    const hasSourceHeaders =
      sourceType === "yc" ||
      (headers.includes("accelerator_year") &&
        headers.includes("country") &&
        headers.includes("source_url"));

    if (hasCommonHeaders && hasSourceHeaders) {
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

function rawValueFor(row: Row, headers: Map<string, number>, key: string) {
  const index = headers.get(key);
  return index === undefined ? null : row[index];
}

function parseAcceleratorYear(value: CellValue | null | undefined) {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 2025 || value === 2026)
  ) {
    return value;
  }

  if (typeof value === "string" && /^(2025|2026)$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function normalizeOfficial500GlobalSourceUrl(value: string) {
  if (!value) return null;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const approved = APPROVED_500_GLOBAL_SOURCE_HOSTS.some(
      (approvedHost) =>
        hostname === approvedHost || hostname.endsWith(`.${approvedHost}`),
    );

    if (url.protocol !== "https:" || !approved) return null;
    return url.toString();
  } catch {
    return null;
  }
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

export async function parseWorkbook(
  file: File,
  sourceType: SourceType = "yc",
): Promise<WorkbookParseResult> {
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
    const headerRowIndex = findHeaderRow(sheet.data, sourceType);

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

      if (sourceType === "500_global") {
        const acceleratorYear = parseAcceleratorYear(
          rawValueFor(row, headers, "accelerator_year"),
        );
        const countryValue = valueFor(row, headers, "country");
        const country = resolveEligibleCountry(countryValue);
        const sourceUrlValue = valueFor(row, headers, "source_url");
        const sourceUrl = normalizeOfficial500GlobalSourceUrl(sourceUrlValue);
        const normalizedFounders = populatedFounders
          .map((founder) => ({
            ...founder,
            normalizedName: normalizeFounderName(founder.name),
          }))
          .filter(
            (
              founder,
            ): founder is typeof founder & {
              normalizedName: NonNullable<typeof founder.normalizedName>;
            } => founder.normalizedName !== null,
          );

        if (!companyName) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Company name is missing",
          );
        }
        if (!normalizedDomain) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Website does not contain a usable domain",
          );
        }
        if (!acceleratorYear) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Accelerator year must be 2025 or 2026",
          );
        }
        if (!country) {
          const reason = isRecognizedCountry(countryValue)
            ? `Country “${countryValue}” is outside Europe and North America`
            : `Country “${countryValue}” is not a recognized country`;
          addInvalidRow(invalidRows, sheet.sheet, sourceRow, reason);
        }
        if (!sourceUrl) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "Official 500 Global source URL is missing or invalid",
          );
        }
        if (normalizedFounders.length === 0) {
          addInvalidRow(
            invalidRows,
            sheet.sheet,
            sourceRow,
            "No usable founder name was provided",
          );
        }

        if (
          !companyName ||
          !normalizedDomain ||
          !acceleratorYear ||
          !country ||
          !sourceUrl ||
          normalizedFounders.length === 0
        ) {
          continue;
        }

        for (const founder of normalizedFounders) {
          const firstCandidateEmail = `${founder.normalizedName.firstName}@${normalizedDomain}`;
          const lastCandidateEmail = founder.normalizedName.lastName
            ? `${founder.normalizedName.lastName}@${normalizedDomain}`
            : null;

          founders.push({
            sourceSheetName: sheet.sheet,
            sourceRow,
            companyName,
            website,
            normalizedDomain,
            ycBatch: null,
            acceleratorName: "500 Global",
            acceleratorBatch:
              valueFor(row, headers, "accelerator_batch") || null,
            acceleratorYear,
            acceleratorRegion: country.region,
            sourceUrl,
            industry: valueFor(row, headers, "industry") || null,
            description: valueFor(row, headers, "description") || null,
            country: country.canonicalName,
            founderName: founder.name,
            normalizedFounderName:
              founder.normalizedName.normalizedFounderName,
            firstName: founder.normalizedName.firstName,
            lastName: founder.normalizedName.lastName,
            founderRole: founder.founderRole || null,
            linkedinUrl: founder.linkedinUrl || null,
            firstCandidateEmail,
            lastCandidateEmail:
              lastCandidateEmail === firstCandidateEmail
                ? null
                : lastCandidateEmail,
          });
        }

        continue;
      }

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
          acceleratorName: null,
          acceleratorBatch: null,
          acceleratorYear: null,
          acceleratorRegion: null,
          sourceUrl: null,
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
      sourceType === "500_global"
        ? "No sheet contains the required company_name, website, accelerator_year, country, source_url, and founder headers."
        : "No sheet contains the required company_name, website, and founder headers.",
    );
  }

  return {
    founders,
    invalidRows: [...invalidRows.values()],
    processedSheets,
    skippedSheets,
  };
}
