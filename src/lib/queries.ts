import "server-only";

import type { FounderStatus } from "@/lib/database.types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SourceType } from "@/lib/types";

export type BatchListItem = {
  id: string;
  batch_name: string;
  source_file_name: string;
  source_type: SourceType;
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
  "catch_all",
  "duplicate_email",
  "no_valid_email",
  "errors",
  "pending",
] as const;

export type BatchResultFilter = (typeof BATCH_RESULT_FILTERS)[number];

export type BatchOutcomeCounts = {
  totalFounders: number;
  validEmails: number;
  catchAllFounders: number;
  duplicateEmails: number;
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
  yc_batch: string | null;
  country: string | null;
  accelerator_name: string | null;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  accelerator_region: "europe" | "north_america" | null;
  source_url: string | null;
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
  "id, batch_name, source_file_name, source_type, status, total_companies, total_founders, duplicate_founders, created_at";

const FOUNDER_LIST_COLUMNS =
  "id, source_sheet_name, source_row, company_name, founder_name, normalized_domain, yc_batch, country, accelerator_name, accelerator_batch, accelerator_year, accelerator_region, source_url, first_candidate_email, last_candidate_email, selected_email, selected_pattern, status, verification_status, is_safe_to_send";

const ATTEMPT_LIST_COLUMNS =
  "id, founder_id, candidate_type, candidate_email, provider, verification_status, is_safe_to_send, is_catch_all, is_role_based, is_disposable, error_message, attempted_at";
const ID_QUERY_CHUNK_SIZE = 1000;
const ATTEMPT_MATCH_CHUNK_SIZE = 100;

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

  const [
    totalResult,
    validResult,
    duplicateEmailResult,
    noValidResult,
    errorResult,
    pendingResult,
    orderedBatchFounderIds,
  ] =
    await Promise.all([
      founderCountQuery(),
      founderCountQuery("valid"),
      founderCountQuery("duplicate_email"),
      founderCountQuery("no_valid_email"),
      founderCountQuery("error"),
      founderCountQuery("pending"),
      loadOrderedBatchFounderIds(batchId),
    ]);

  const countError =
    totalResult.error ??
    validResult.error ??
    duplicateEmailResult.error ??
    noValidResult.error ??
    errorResult.error ??
    pendingResult.error;
  if (countError) throw new Error(countError.message);

  const catchAllFounderIds = await loadCatchAllFounderIds(
    orderedBatchFounderIds,
  );

  const counts: BatchOutcomeCounts = {
    totalFounders: totalResult.count ?? 0,
    validEmails: validResult.count ?? 0,
    catchAllFounders: catchAllFounderIds.length,
    duplicateEmails: duplicateEmailResult.count ?? 0,
    noValidEmails: noValidResult.count ?? 0,
    verificationErrors: errorResult.count ?? 0,
    pendingFounders: pendingResult.count ?? 0,
  };
  const totalItems = filteredTotal(counts, filter);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * pageSize;

  let founderData: Array<Omit<FounderListItem, "attempts">> = [];
  let foundersError: { message: string } | null = null;

  if (filter === "catch_all") {
    const pageFounderIds = catchAllFounderIds.slice(from, from + pageSize);
    if (pageFounderIds.length > 0) {
      const result = await supabase
        .from("fev_founders")
        .select(FOUNDER_LIST_COLUMNS)
        .eq("batch_id", batchId)
        .in("id", pageFounderIds);
      foundersError = result.error;
      const order = new Map(pageFounderIds.map((id, index) => [id, index]));
      founderData = (
        (result.data ?? []) as Array<Omit<FounderListItem, "attempts">>
      ).sort(
        (left, right) =>
          (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }
  } else {
    let foundersQuery = supabase
      .from("fev_founders")
      .select(FOUNDER_LIST_COLUMNS)
      .eq("batch_id", batchId);
    const founderStatus = filterToFounderStatus(filter);
    if (founderStatus) foundersQuery = foundersQuery.eq("status", founderStatus);

    const result = await foundersQuery
      .order("company_name", { ascending: true })
      .order("founder_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    foundersError = result.error;
    founderData = (result.data ?? []) as Array<
      Omit<FounderListItem, "attempts">
    >;
  }

  if (foundersError) throw new Error(foundersError.message);

  const founders = founderData;
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
  if (filter === "errors") return "error";
  if (filter === "all" || filter === "catch_all") return null;
  return filter;
}

function filteredTotal(counts: BatchOutcomeCounts, filter: BatchResultFilter) {
  if (filter === "valid") return counts.validEmails;
  if (filter === "catch_all") return counts.catchAllFounders;
  if (filter === "duplicate_email") return counts.duplicateEmails;
  if (filter === "no_valid_email") return counts.noValidEmails;
  if (filter === "errors") return counts.verificationErrors;
  if (filter === "pending") return counts.pendingFounders;
  return counts.totalFounders;
}

function emptyOutcomeCounts(): BatchOutcomeCounts {
  return {
    totalFounders: 0,
    validEmails: 0,
    catchAllFounders: 0,
    duplicateEmails: 0,
    noValidEmails: 0,
    verificationErrors: 0,
    pendingFounders: 0,
  };
}

function emptyPagination(pageSize: number): BatchPagination {
  return { page: 1, pageSize, totalItems: 0, totalPages: 1 };
}

async function loadOrderedBatchFounderIds(batchId: string) {
  const supabase = getSupabaseAdmin();
  const founderIds: string[] = [];

  for (let offset = 0; ; offset += ID_QUERY_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("fev_founders")
      .select("id")
      .eq("batch_id", batchId)
      .order("company_name", { ascending: true })
      .order("founder_name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + ID_QUERY_CHUNK_SIZE - 1);

    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    founderIds.push(...chunk.map((founder) => founder.id));
    if (chunk.length < ID_QUERY_CHUNK_SIZE) break;
  }

  return founderIds;
}

async function loadCatchAllFounderIds(orderedFounderIds: string[]) {
  const supabase = getSupabaseAdmin();
  const matchingFounderIds = new Set<string>();

  for (
    let index = 0;
    index < orderedFounderIds.length;
    index += ATTEMPT_MATCH_CHUNK_SIZE
  ) {
    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .select("founder_id")
      .in(
        "founder_id",
        orderedFounderIds.slice(index, index + ATTEMPT_MATCH_CHUNK_SIZE),
      )
      .or("verification_status.eq.catch_all,is_catch_all.eq.true");

    if (error) throw new Error(error.message);
    for (const attempt of data ?? []) matchingFounderIds.add(attempt.founder_id);
  }

  return orderedFounderIds.filter((id) => matchingFounderIds.has(id));
}
