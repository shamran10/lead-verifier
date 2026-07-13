import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";

const EXPORT_CHUNK_SIZE = 1000;
const CSV_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "full_name",
  "company_name",
  "website",
  "domain",
  "linkedin_url",
  "yc_batch",
  "industry",
  "country",
  "source_file",
  "batch_name",
  "selected_pattern",
] as const;

type ExportColumn = (typeof CSV_COLUMNS)[number];
type CsvValue = string | null;
type CsvRow = Record<ExportColumn, CsvValue>;

type ExportFounder = {
  id: string;
  created_at: string;
  founder_name: string;
  company_name: string;
  website: string | null;
  normalized_domain: string;
  linkedin_url: string | null;
  yc_batch: string | null;
  industry: string | null;
  country: string | null;
  selected_email: string | null;
  selected_pattern: string | null;
};

export class SmartleadExportError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function createSmartleadExport(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { data: batch, error: batchError } = await supabase
    .from("fev_batches")
    .select("id, batch_name, source_file_name")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) {
    throw new SmartleadExportError("Could not load the export batch.", 500);
  }
  if (!batch) {
    throw new SmartleadExportError("Batch not found.", 404);
  }

  const founders: ExportFounder[] = [];
  for (let offset = 0; ; offset += EXPORT_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("fev_founders")
      .select(
        "id, created_at, founder_name, company_name, website, normalized_domain, linkedin_url, yc_batch, industry, country, selected_email, selected_pattern",
      )
      .eq("batch_id", batchId)
      .eq("status", "valid")
      .eq("is_safe_to_send", true)
      .not("selected_email", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + EXPORT_CHUNK_SIZE - 1);

    if (error) {
      throw new SmartleadExportError(
        "Could not load founders for export.",
        500,
      );
    }

    const chunk = (data ?? []) as ExportFounder[];
    founders.push(...chunk);
    if (chunk.length < EXPORT_CHUNK_SIZE) break;
  }

  const seenEmails = new Set<string>();
  const rows: CsvRow[] = [];

  for (const founder of founders) {
    const email = founder.selected_email?.trim().toLowerCase() ?? "";
    if (!email || seenEmails.has(email)) continue;

    seenEmails.add(email);
    const { firstName, lastName } = displayNameParts(founder.founder_name);
    rows.push({
      email,
      first_name: firstName,
      last_name: lastName,
      full_name: founder.founder_name,
      company_name: founder.company_name,
      website: founder.website,
      domain: founder.normalized_domain,
      linkedin_url: founder.linkedin_url,
      yc_batch: founder.yc_batch,
      industry: founder.industry,
      country: founder.country,
      source_file: batch.source_file_name,
      batch_name: batch.batch_name,
      selected_pattern: founder.selected_pattern,
    });
  }

  if (rows.length === 0) {
    throw new SmartleadExportError(
      "No valid and safe founders are available for export.",
      422,
    );
  }

  return {
    csv: toCsv(rows),
    filename: smartleadFilename(batch.batch_name),
    rowCount: rows.length,
  };
}

function displayNameParts(founderName: string) {
  const parts = founderName.trim().split(/\s+/u).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
  };
}

function toCsv(rows: CsvRow[]) {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      CSV_COLUMNS.map((column) => csvCell(row[column])).join(","),
    ),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function csvCell(value: CsvValue) {
  const text = preventSpreadsheetFormula(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function preventSpreadsheetFormula(value: string) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function smartleadFilename(batchName: string) {
  const slug = batchName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  return `smartlead-${slug || "batch"}-${date}.csv`;
}
