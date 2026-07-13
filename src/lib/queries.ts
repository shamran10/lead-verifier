import "server-only";

import type { FounderStatus } from "@/lib/database.types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type BatchListItem = {
  id: string;
  batch_name: string;
  source_file_name: string;
  status: string;
  total_companies: number;
  total_founders: number;
  duplicate_founders: number;
  created_at: string;
};

export type BatchDetail = BatchListItem & {
  valid_emails: number;
  no_valid_emails: number;
};

export const BATCH_RESULT_FILTERS = [
  "all",
  "valid",
  "no_valid_email",
  "errors",
  "pending",
] as const;

export type BatchResultFilter = (typeof BATCH_RESULT_FILTERS)[number];

export type BatchOutcomeCounts = {
  totalFounders: number;
  validEmails: number;
  noValidEmails: number;
  verificationErrors: number;
  pendingFounders: number;
};

export type VerificationAttemptListItem = {
  id: string;
  founder_id: string;
  candidate_type: string;
  candidate_email: string;
  provider: string;
  verification_status: string | null;
  is_safe_to_send: boolean | null;
  is_catch_all: boolean | null;
  is_role_based: boolean | null;
  is_disposable: boolean | null;
  error_message: string | null;
  attempted_at: string;
};

export type FounderListItem = {
  id: string;
  source_sheet_name: string | null;
  source_row: number | null;
  company_name: string;
  founder_name: string;
  normalized_domain: string;
  first_candidate_email: string;
  last_candidate_email: string | null;
  selected_email: string | null;
  selected_pattern: string | null;
  status: string;
  verification_status: string | null;
  is_safe_to_send: boolean | null;
  attempts: VerificationAttemptListItem[];
};

export type BatchPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type BatchDetailOptions = {
  filter?: BatchResultFilter;
  page?: number;
  pageSize?: number;
};

const BATCH_LIST_COLUMNS =
  "id, batch_name, source_file_name, status, total_companies, total_founders, duplicate_founders, created_at";

const FOUNDER_LIST_COLUMNS =
  "id, source_sheet_name, source_row, company_name, founder_name, normalized_domain, first_candidate_email, last_candidate_email, selected_email, selected_pattern, status, verification_status, is_safe_to_send";

const ATTEMPT_LIST_COLUMNS =
  "id, founder_id, candidate_type, candidate_email, provider, verification_status, is_safe_to_send, is_catch_all, is_role_based, is_disposable, error_message, attempted_at";

export function normalizeBatchResultFilter(
  value: string | string[] | undefined,
): BatchResultFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return BATCH_RESULT_FILTERS.includes(candidate as BatchResultFilter)
    ? (candidate as BatchResultFilter)
    : "all";
}

export async function getRecentBatches(limit = 25) {
  const { data, error } = await getSupabaseAdmin()
    .from("fev_batches")
    .select(BATCH_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as BatchListItem[];
}

export async function getDashboardData() {
  const supabase = getSupabaseAdmin();
  const [batchCountResult, founderCountResult, pendingCountResult, recent] =
    await Promise.all([
      supabase.from("fev_batches").select("id", { count: "exact", head: true }),
      supabase.from("fev_founders").select("id", { count: "exact", head: true }),
      supabase
        .from("fev_founders")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      getRecentBatches(5),
    ]);

  const error =
    batchCountResult.error ?? founderCountResult.error ?? pendingCountResult.error;
  if (error) {
    throw new Error(error.message);
  }

  return {
    batchCount: batchCountResult.count ?? 0,
    founderCount: founderCountResult.count ?? 0,
    pendingCount: pendingCountResult.count ?? 0,
    recent,
  };
}

export async function getBatchDetails(
  batchId: string,
  options: BatchDetailOptions = {},
) {
  const supabase = getSupabaseAdmin();
  const filter = options.filter ?? "all";
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 50)));

  const { data: batchData, error: batchError } = await supabase
    .from("fev_batches")
    .select(`${BATCH_LIST_COLUMNS}, valid_emails, no_valid_emails`)
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) throw new Error(batchError.message);
  if (!batchData) {
    return {
      batch: null,
      founders: [] as FounderListItem[],
      counts: emptyOutcomeCounts(),
      pagination: emptyPagination(pageSize),
      filter,
    };
  }

  const founderCountQuery = (status?: FounderStatus) => {
    let query = supabase
      .from("fev_founders")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId);
    if (status) query = query.eq("status", status);
    return query;
  };

  const [totalResult, validResult, noValidResult, errorResult, pendingResult] =
    await Promise.all([
      founderCountQuery(),
      founderCountQuery("valid"),
      founderCountQuery("no_valid_email"),
      founderCountQuery("verification_error"),
      founderCountQuery("pending"),
    ]);

  const countError =
    totalResult.error ??
    validResult.error ??
    noValidResult.error ??
    errorResult.error ??
    pendingResult.error;
  if (countError) throw new Error(countError.message);

  const counts: BatchOutcomeCounts = {
    totalFounders: totalResult.count ?? 0,
    validEmails: validResult.count ?? 0,
    noValidEmails: noValidResult.count ?? 0,
    verificationErrors: errorResult.count ?? 0,
    pendingFounders: pendingResult.count ?? 0,
  };
  const totalItems = filteredTotal(counts, filter);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * pageSize;

  let foundersQuery = supabase
    .from("fev_founders")
    .select(FOUNDER_LIST_COLUMNS)
    .eq("batch_id", batchId);
  const founderStatus = filterToFounderStatus(filter);
  if (founderStatus) foundersQuery = foundersQuery.eq("status", founderStatus);

  const { data: founderData, error: foundersError } = await foundersQuery
    .order("company_name", { ascending: true })
    .order("founder_name", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);

  if (foundersError) throw new Error(foundersError.message);

  const founders = (founderData ?? []) as Array<Omit<FounderListItem, "attempts">>;
  const founderIds = founders.map((founder) => founder.id);
  let attempts: VerificationAttemptListItem[] = [];

  if (founderIds.length > 0) {
    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .select(ATTEMPT_LIST_COLUMNS)
      .in("founder_id", founderIds)
      .order("attempted_at", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw new Error(error.message);
    attempts = (data ?? []) as VerificationAttemptListItem[];
  }

  const attemptsByFounder = new Map<string, VerificationAttemptListItem[]>();
  for (const attempt of attempts) {
    const founderAttempts = attemptsByFounder.get(attempt.founder_id) ?? [];
    founderAttempts.push(attempt);
    attemptsByFounder.set(attempt.founder_id, founderAttempts);
  }

  return {
    batch: batchData as BatchDetail,
    founders: founders.map((founder) => ({
      ...founder,
      attempts: attemptsByFounder.get(founder.id) ?? [],
    })),
    counts,
    pagination: { page, pageSize, totalItems, totalPages } satisfies BatchPagination,
    filter,
  };
}

function filterToFounderStatus(filter: BatchResultFilter): FounderStatus | null {
  if (filter === "errors") return "verification_error";
  if (filter === "all") return null;
  return filter;
}

function filteredTotal(counts: BatchOutcomeCounts, filter: BatchResultFilter) {
  if (filter === "valid") return counts.validEmails;
  if (filter === "no_valid_email") return counts.noValidEmails;
  if (filter === "errors") return counts.verificationErrors;
  if (filter === "pending") return counts.pendingFounders;
  return counts.totalFounders;
}

function emptyOutcomeCounts(): BatchOutcomeCounts {
  return {
    totalFounders: 0,
    validEmails: 0,
    noValidEmails: 0,
    verificationErrors: 0,
    pendingFounders: 0,
  };
}

function emptyPagination(pageSize: number): BatchPagination {
  return { page: 1, pageSize, totalItems: 0, totalPages: 1 };
}
