import "server-only";

import {
  createCsv,
  displayNameParts,
  exportFilename,
  type CsvValue,
} from "@/lib/csv-export";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const EXPORT_CHUNK_SIZE = 1000;
const ATTEMPT_QUERY_CHUNK_SIZE = 100;
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
const GLOBAL_500_COLUMNS = [
  ...CSV_COLUMNS,
  "source_type",
  "accelerator_name",
  "accelerator_batch",
  "accelerator_year",
  "accelerator_region",
  "source_url",
] as const;

type ExportFounder = {
  id: string;
  created_at: string;
  founder_name: string;
  company_name: string;
  website: string | null;
  normalized_domain: string;
  linkedin_url: string | null;
  yc_batch: string | null;
  accelerator_name: string | null;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  accelerator_region: string | null;
  source_url: string | null;
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
    .select("id, batch_name, source_file_name, source_type")
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
        "id, created_at, founder_name, company_name, website, normalized_domain, linkedin_url, yc_batch, accelerator_name, accelerator_batch, accelerator_year, accelerator_region, source_url, industry, country, selected_email, selected_pattern",
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
  const verifiedAttemptKeys = await loadVerifiedAttemptKeys(
    founders.map((founder) => founder.id),
  );
  const rows: CsvValue[][] = [];

  for (const founder of founders) {
    const email = founder.selected_email?.trim().toLowerCase() ?? "";
    if (
      !email ||
      seenEmails.has(email) ||
      !verifiedAttemptKeys.has(attemptKey(founder.id, email))
    ) {
      continue;
    }

    seenEmails.add(email);
    const { firstName, lastName } = displayNameParts(founder.founder_name);
    const row: CsvValue[] = [
      email,
      firstName,
      lastName,
      founder.founder_name,
      founder.company_name,
      founder.website,
      founder.normalized_domain,
      founder.linkedin_url,
      founder.yc_batch,
      founder.industry,
      founder.country,
      batch.source_file_name,
      batch.batch_name,
      founder.selected_pattern,
    ];

    if (batch.source_type === "500_global") {
      row.push(
        batch.source_type,
        founder.accelerator_name,
        founder.accelerator_batch,
        founder.accelerator_year?.toString() ?? null,
        founder.accelerator_region,
        founder.source_url,
      );
    }

    rows.push(row);
  }

  if (rows.length === 0) {
    throw new SmartleadExportError(
      "No valid and safe founders are available for export.",
      422,
    );
  }

  return {
    csv: createCsv(
      batch.source_type === "500_global" ? GLOBAL_500_COLUMNS : CSV_COLUMNS,
      rows,
    ),
    filename: exportFilename("smartlead", batch.batch_name),
    rowCount: rows.length,
  };
}

async function loadVerifiedAttemptKeys(founderIds: string[]) {
  const supabase = getSupabaseAdmin();
  const keys = new Set<string>();

  for (
    let index = 0;
    index < founderIds.length;
    index += ATTEMPT_QUERY_CHUNK_SIZE
  ) {
    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .select(
        "founder_id, candidate_email, verification_status, is_safe_to_send, is_catch_all",
      )
      .in(
        "founder_id",
        founderIds.slice(index, index + ATTEMPT_QUERY_CHUNK_SIZE),
      )
      .eq("verification_status", "valid")
      .eq("is_safe_to_send", true);

    if (error) {
      throw new SmartleadExportError(
        "Could not confirm selected verification attempts.",
        500,
      );
    }

    for (const attempt of data ?? []) {
      if (attempt.is_catch_all === true) continue;
      const email = attempt.candidate_email.trim().toLowerCase();
      if (email) keys.add(attemptKey(attempt.founder_id, email));
    }
  }

  return keys;
}

function attemptKey(founderId: string, email: string) {
  return `${founderId}\u0000${email}`;
}
