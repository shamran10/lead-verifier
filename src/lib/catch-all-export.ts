import "server-only";

import type { AttemptVerificationStatus } from "@/lib/database.types";
import {
  createCsv,
  displayNameParts,
  exportFilename,
  type CsvValue,
} from "@/lib/csv-export";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const FOUNDER_QUERY_CHUNK_SIZE = 1000;
const ATTEMPT_QUERY_CHUNK_SIZE = 100;
const CATCH_ALL_COLUMNS = [
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
  "candidate_pattern",
  "verification_status",
  "is_catch_all",
  "is_safe_to_send",
] as const;
const GLOBAL_500_CATCH_ALL_COLUMNS = [
  ...CATCH_ALL_COLUMNS,
  "source_type",
  "accelerator_name",
  "accelerator_batch",
  "accelerator_year",
  "accelerator_region",
  "source_url",
] as const;

const EXCLUDED_STATUSES = new Set<AttemptVerificationStatus>([
  "valid",
  "unknown",
  "unsafe",
  "invalid",
  "error",
  "role_based",
  "disposable",
  "risky",
  "spamtrap",
  "disabled",
  "inbox_full",
  "processing",
  "malformed",
  "malformed_response",
  "provider_error",
  "timeout",
]);

type CatchAllFounder = {
  id: string;
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
};

type CatchAllAttempt = {
  id: string;
  founder_id: string;
  candidate_type: string;
  candidate_email: string;
  verification_status: AttemptVerificationStatus | null;
  is_catch_all: boolean | null;
  attempted_at: string;
};

export class CatchAllExportError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function createCatchAllExport(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { data: batch, error: batchError } = await supabase
    .from("fev_batches")
    .select("id, batch_name, source_file_name, source_type")
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) {
    throw new CatchAllExportError("Could not load the export batch.", 500);
  }
  if (!batch) {
    throw new CatchAllExportError("Batch not found.", 404);
  }

  const founders = await loadBatchFounders(batchId);
  const founderMap = new Map(founders.map((founder) => [founder.id, founder]));
  const attempts = await loadCatchAllAttempts(founders.map((founder) => founder.id));
  attempts.sort(
    (left, right) =>
      left.attempted_at.localeCompare(right.attempted_at) ||
      left.id.localeCompare(right.id),
  );

  const seenEmails = new Set<string>();
  const rows: CsvValue[][] = [];

  for (const attempt of attempts) {
    if (
      attempt.verification_status &&
      EXCLUDED_STATUSES.has(attempt.verification_status)
    ) {
      continue;
    }

    const email = attempt.candidate_email.trim().toLowerCase();
    const founder = founderMap.get(attempt.founder_id);
    if (!email || !founder || seenEmails.has(email)) continue;

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
      attempt.candidate_type,
      "catch_all",
      "true",
      "false",
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
    throw new CatchAllExportError(
      "No catch-all candidate emails are available for export.",
      422,
    );
  }

  return {
    csv: createCsv(
      batch.source_type === "500_global"
        ? GLOBAL_500_CATCH_ALL_COLUMNS
        : CATCH_ALL_COLUMNS,
      rows,
    ),
    filename: exportFilename("catch-all", batch.batch_name),
    rowCount: rows.length,
  };
}

async function loadBatchFounders(batchId: string) {
  const supabase = getSupabaseAdmin();
  const founders: CatchAllFounder[] = [];

  for (let offset = 0; ; offset += FOUNDER_QUERY_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("fev_founders")
      .select(
        "id, founder_name, company_name, website, normalized_domain, linkedin_url, yc_batch, accelerator_name, accelerator_batch, accelerator_year, accelerator_region, source_url, industry, country",
      )
      .eq("batch_id", batchId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + FOUNDER_QUERY_CHUNK_SIZE - 1);

    if (error) {
      throw new CatchAllExportError(
        "Could not load founders for catch-all export.",
        500,
      );
    }

    const chunk = (data ?? []) as CatchAllFounder[];
    founders.push(...chunk);
    if (chunk.length < FOUNDER_QUERY_CHUNK_SIZE) break;
  }

  return founders;
}

async function loadCatchAllAttempts(founderIds: string[]) {
  const supabase = getSupabaseAdmin();
  const attempts: CatchAllAttempt[] = [];

  for (
    let index = 0;
    index < founderIds.length;
    index += ATTEMPT_QUERY_CHUNK_SIZE
  ) {
    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .select(
        "id, founder_id, candidate_type, candidate_email, verification_status, is_catch_all, attempted_at",
      )
      .in(
        "founder_id",
        founderIds.slice(index, index + ATTEMPT_QUERY_CHUNK_SIZE),
      )
      .or("verification_status.eq.catch_all,is_catch_all.eq.true");

    if (error) {
      throw new CatchAllExportError(
        "Could not load catch-all verification attempts.",
        500,
      );
    }

    attempts.push(...((data ?? []) as CatchAllAttempt[]));
  }

  return attempts;
}
