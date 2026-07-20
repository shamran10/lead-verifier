import "server-only";

import {
  DiscoveryError,
  type DiscoveryCompanyReviewItem,
  type DiscoveryEnrichmentProgress,
  type DiscoveryEventLevel,
  type DiscoveryFinderProgress,
  type DiscoveryReviewFilter,
  type DiscoveryReviewPagination,
  type DiscoveryRunListItem,
} from "@/lib/500-global/types";
import {
  evaluateDiscoveryEligibility,
  type LocationResolution,
} from "@/lib/500-global/eligibility";
import {
  normalizeDiscoverySourceUrl,
  parseDiscoverySourceKind,
} from "@/lib/500-global/source-policy";
import { normalizeDomain, normalizeFounderName } from "@/lib/founder-normalization";
import { resolveCountry, resolveEligibleCountry } from "@/lib/geography";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { Database } from "@/lib/database.types";

const ALLOWED_YEARS = new Set([2025, 2026]);
const ALLOWED_REGIONS = new Set(["europe", "north_america"]);

export type CreateDiscoveryRunInput = {
  name: unknown;
  targetYears: unknown;
  targetRegions: unknown;
  maxRecords: unknown;
  dryRun: unknown;
};

export async function createDiscoveryRun(input: CreateDiscoveryRunInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new DiscoveryError("Enter a run name.", 400);
  if (name.length > 120) {
    throw new DiscoveryError("Run name must be 120 characters or fewer.", 400);
  }

  const targetYears = parseNumberSelection(input.targetYears, ALLOWED_YEARS);
  if (!targetYears?.length) {
    throw new DiscoveryError("Select 2025 and/or 2026.", 400);
  }
  const targetRegions = parseStringSelection(
    input.targetRegions,
    ALLOWED_REGIONS,
  );
  if (!targetRegions?.length) {
    throw new DiscoveryError(
      "Select Europe and/or North America.",
      400,
    );
  }

  const maxRecords = Number(input.maxRecords);
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000) {
    throw new DiscoveryError(
      "Maximum records must be a whole number from 1 to 1,000.",
      400,
    );
  }
  if (typeof input.dryRun !== "boolean") {
    throw new DiscoveryError("Dry run must be true or false.", 400);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_runs")
    .insert({
      name,
      status: "draft",
      target_years: targetYears,
      target_regions: targetRegions,
      max_records: maxRecords,
      dry_run: input.dryRun,
    })
    .select("*")
    .single();

  if (error || !data) {
    logSupabaseError("fev_500global_runs.insert", error ?? {
      code: "NO_DATA",
      message: "Insert returned no run row.",
      details: null,
      hint: null,
    });
    throw new DiscoveryError(
      `Could not create the discovery run: ${error?.message ?? "Unknown error"}`,
      500,
    );
  }

  try {
    await recordDiscoveryEvent(data.id, "run_created", "Discovery run created.");
  } catch (eventError) {
    await supabase.from("fev_500global_runs").delete().eq("id", data.id);
    throw eventError;
  }
  return data;
}

export async function listDiscoveryRuns(limit = 50) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) {
    throw new DiscoveryError(`Could not load discovery runs: ${error.message}`, 500);
  }
  return (data ?? []) as DiscoveryRunListItem[];
}

export async function getDiscoveryRun(runId: string) {
  const supabase = getSupabaseAdmin();
  const [runResult, sourceResult, eventResult] = await Promise.all([
    supabase.from("fev_500global_runs").select("*").eq("id", runId).maybeSingle(),
    supabase
      .from("fev_500global_sources")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false }),
    supabase
      .from("fev_500global_events")
      .select("id, level, event_type, message, created_at")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (runResult.error) {
    throw new DiscoveryError(`Could not load the run: ${runResult.error.message}`, 500);
  }
  if (!runResult.data) throw new DiscoveryError("Discovery run not found.", 404);
  if (sourceResult.error) {
    throw new DiscoveryError(`Could not load sources: ${sourceResult.error.message}`, 500);
  }
  if (eventResult.error) {
    throw new DiscoveryError(`Could not load run events: ${eventResult.error.message}`, 500);
  }

  return {
    run: runResult.data,
    sources: sourceResult.data ?? [],
    events: eventResult.data ?? [],
  };
}

export async function addDiscoverySource(
  runId: string,
  input: {
    url: unknown;
    sourceKind: unknown;
    acceleratorBatch: unknown;
    acceleratorYear: unknown;
    approvePartnerHost: unknown;
  },
) {
  await requireMutableRun(runId);
  const sourceKind = parseDiscoverySourceKind(input.sourceKind);
  if (!sourceKind) throw new DiscoveryError("Choose a supported source kind.", 400);
  const source = normalizeDiscoverySourceUrl(
    typeof input.url === "string" ? input.url : "",
  );
  const acceleratorBatch = optionalText(input.acceleratorBatch, 120);
  const acceleratorYear = optionalYear(input.acceleratorYear);
  const approvePartnerHost = input.approvePartnerHost === true;
  const approved = source.approvedByDefault || approvePartnerHost;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_sources")
    .insert({
      run_id: runId,
      url: source.url,
      normalized_url: source.normalizedUrl,
      hostname: source.hostname,
      source_kind: sourceKind,
      approval_status: approved ? "approved" : "pending",
      processing_status: "pending",
      host_approved_by_admin: !source.approvedByDefault && approvePartnerHost,
      official_evidence: source.approvedByDefault,
      accelerator_batch: acceleratorBatch,
      accelerator_year: acceleratorYear,
    })
    .select("*")
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      throw new DiscoveryError("That normalized source URL is already in this run.", 409);
    }
    throw new DiscoveryError(`Could not add the source: ${error?.message ?? "Unknown error"}`, 500);
  }

  try {
    await recordDiscoveryEvent(runId, "source_added", "Curated source added.", {
      sourceId: data.id,
    });
  } catch (eventError) {
    await supabase.from("fev_500global_sources").delete().eq("id", data.id);
    throw eventError;
  }
  try {
    await refreshDiscoveryRunCounters(runId);
  } catch {
    // Source rows remain authoritative if a denormalized counter refresh fails.
  }
  return data;
}

export async function recordRejectedSource(runId: string) {
  try {
    await recordDiscoveryEvent(
      runId,
      "source_rejected",
      "A source URL was rejected by validation or policy.",
      { level: "warning" },
    );
  } catch {
    // Preserve the original validation response when audit logging is unavailable.
  }
}

export async function getDiscoveryReview(
  runId: string,
  filter: DiscoveryReviewFilter,
  page: number,
  pageSize: number,
): Promise<{
  companies: DiscoveryCompanyReviewItem[];
  pagination: DiscoveryReviewPagination;
}> {
  await requireRun(runId);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const safePage = Math.max(page, 1);
  const from = (safePage - 1) * safePageSize;
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("fev_500global_discovered_companies")
    .select("*", { count: "exact" })
    .eq("run_id", runId);

  if (["eligible", "needs_review", "ineligible"].includes(filter)) {
    query = query.eq("eligibility_status", filter as "eligible" | "needs_review" | "ineligible");
  } else if (filter === "approved" || filter === "rejected") {
    query = query.eq("review_status", filter);
  } else if (filter === "action_required") {
    query = query
      .eq("review_status", "pending")
      .in("eligibility_status", ["eligible", "needs_review"]);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + safePageSize - 1);
  if (error) {
    throw new DiscoveryError(`Could not load review companies: ${error.message}`, 500);
  }

  const companies = data ?? [];
  const companyIds = companies.map((company) => company.id);
  const { data: founders, error: founderError } = companyIds.length
    ? await supabase
        .from("fev_500global_discovered_founders")
        .select("*")
        .in("company_id", companyIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (founderError) {
    throw new DiscoveryError(`Could not load review founders: ${founderError.message}`, 500);
  }

  const foundersByCompany = new Map<
    string,
    Database["public"]["Tables"]["fev_500global_discovered_founders"]["Row"][]
  >();
  for (const founder of founders ?? []) {
    const current = foundersByCompany.get(founder.company_id) ?? [];
    current.push(founder);
    foundersByCompany.set(founder.company_id, current);
  }
  const totalItems = count ?? 0;
  return {
    companies: companies.map((company) => ({
      ...company,
      founders: foundersByCompany.get(company.id) ?? [],
    })),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / safePageSize)),
    },
  };
}

export async function editDiscoveryCompany(
  runId: string,
  companyId: string,
  input: Record<string, unknown>,
) {
  const company = await requireMutableCompany(runId, companyId);
  const companyName = requiredText(input.companyName, "Company name", 200);
  const website = requiredText(input.website, "Website", 500);
  const normalizedDomain = normalizeDomain(website);
  if (!normalizedDomain) throw new DiscoveryError("Website must contain a usable domain.", 400);
  const countryInput = requiredText(input.country, "Country", 120);
  const country = resolveEligibleCountry(countryInput);
  if (!country) {
    throw new DiscoveryError("Country must be an eligible European or North American country.", 400);
  }
  const acceleratorYear = optionalYear(input.acceleratorYear, true);
  const sourceUrl = normalizeDiscoverySourceUrl(
    requiredText(input.sourceUrl, "Source URL", 1000),
  ).normalizedUrl;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .update({
      company_name: companyName,
      normalized_company_name: companyName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 200),
      website,
      normalized_domain: normalizedDomain,
      headquarters_country: country.canonicalName,
      headquarters_iso2: country.iso2,
      accelerator_batch: optionalText(input.acceleratorBatch, 120),
      accelerator_year: acceleratorYear,
      accelerator_region: country.region,
      source_url: sourceUrl,
      description: optionalText(input.description, 2000),
      industry: optionalText(input.industry, 200),
      review_status: "pending",
      import_status: "not_ready",
      enrichment_status: "pending",
      evidence_summary: mergeJsonObject(company.evidence_summary, {
        location_resolution: "manual_confirmed",
        location_authority: "operator",
        manually_confirmed_country: country.canonicalName,
        manually_confirmed_iso2: country.iso2,
      }),
    })
    .eq("id", company.id);
  if (error) throw new DiscoveryError(`Could not edit the company: ${error.message}`, 500);

  await recalculateCompanyEligibility(runId, companyId);
  await recordDiscoveryEvent(runId, "company_edited", "Company metadata edited.", {
    companyId,
  });
  return getCompanyWithFounders(companyId);
}

export async function reviewDiscoveryCompany(
  runId: string,
  companyId: string,
  decision: "approved" | "rejected",
) {
  await requireMutableCompany(runId, companyId);
  if (decision === "approved") {
    const eligibility = await recalculateCompanyEligibility(runId, companyId);
    if (eligibility !== "eligible") {
      throw new DiscoveryError(
        "Only eligible or manually corrected companies can be approved.",
        409,
      );
    }
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .update({
      review_status: decision,
      import_status: decision === "approved" ? "ready" : "not_ready",
    })
    .eq("id", companyId);
  if (error) throw new DiscoveryError(`Could not review the company: ${error.message}`, 500);
  await Promise.all([
    recordDiscoveryEvent(
      runId,
      decision === "approved" ? "company_approved" : "company_rejected",
      decision === "approved" ? "Company approved for import." : "Company rejected from import.",
      { companyId },
    ),
    refreshDiscoveryRunCounters(runId),
  ]);
}

export async function reviewDiscoveryFounder(
  runId: string,
  founderId: string,
  decision: "approved" | "rejected",
) {
  const founder = await requireMutableFounder(runId, founderId);
  if (!normalizeFounderName(founder.founder_name)) {
    throw new DiscoveryError("Founder name is not usable.", 409);
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_founders")
    .update({
      review_status: decision,
      active_status: decision === "approved" ? "confirmed" : founder.active_status,
      include_in_import: decision === "approved",
      import_status: decision === "approved" ? "ready" : "not_ready",
    })
    .eq("id", founderId);
  if (error) throw new DiscoveryError(`Could not review the founder: ${error.message}`, 500);
  await recordDiscoveryEvent(
    runId,
    decision === "approved" ? "founder_approved" : "founder_rejected",
    decision === "approved" ? "Founder approved for import." : "Founder rejected from import.",
    { companyId: founder.company_id, founderId },
  );
  await recalculateCompanyEligibility(runId, founder.company_id);
}

export async function setDiscoveryFounderIncluded(
  runId: string,
  founderId: string,
  include: boolean,
) {
  const founder = await requireMutableFounder(runId, founderId);
  if (
    include &&
    (founder.review_status !== "approved" || founder.active_status !== "confirmed")
  ) {
    throw new DiscoveryError(
      "Approve and confirm the founder before including them in import.",
      409,
    );
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_founders")
    .update({ include_in_import: include })
    .eq("id", founderId);
  if (error) throw new DiscoveryError(`Could not update founder inclusion: ${error.message}`, 500);
  await recordDiscoveryEvent(
    runId,
    "founder_inclusion_changed",
    include ? "Founder included in import." : "Founder excluded from import.",
    { companyId: founder.company_id, founderId },
  );
}

export async function recordDiscoveryEvent(
  runId: string,
  eventType: string,
  message: string,
  options: {
    level?: DiscoveryEventLevel;
    sourceId?: string;
    companyId?: string;
    founderId?: string;
    details?: Record<string, string | number | boolean | null>;
  } = {},
) {
  const supabase = getSupabaseAdmin();
  const details = sanitizeEventDetails({
    ...options.details,
    ...(options.founderId ? { founder_id: options.founderId } : {}),
  });
  const { error } = await supabase.from("fev_500global_events").insert({
    run_id: runId,
    source_id: options.sourceId ?? null,
    company_id: options.companyId ?? null,
    level: options.level ?? "info",
    event_type: eventType.slice(0, 80),
    message: message.slice(0, 500),
    details,
  });
  if (error) {
    logSupabaseError("fev_500global_events.insert", error);
    throw new DiscoveryError(
      `Could not record the discovery event: ${error.message}`,
      500,
    );
  }
}

export async function recordDiscoveryEventOnce(
  runId: string,
  eventType: string,
  message: string,
  options: {
    level?: DiscoveryEventLevel;
    sourceId?: string;
    companyId?: string;
    founderId?: string;
    details?: Record<string, string | number | boolean | null>;
  } = {},
) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("fev_500global_events")
    .select("id")
    .eq("run_id", runId)
    .eq("event_type", eventType.slice(0, 80))
    .eq("message", message.slice(0, 500));
  query = options.sourceId
    ? query.eq("source_id", options.sourceId)
    : query.is("source_id", null);
  query = options.companyId
    ? query.eq("company_id", options.companyId)
    : query.is("company_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    logSupabaseError("fev_500global_events.select_once", error);
    throw new DiscoveryError("Could not inspect discovery events.", 500);
  }
  if (data) return false;
  await recordDiscoveryEvent(runId, eventType, message, options);
  return true;
}

type SupabaseErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

function logSupabaseError(operation: string, error: SupabaseErrorLike) {
  console.error("[500 Global discovery] Supabase operation failed", {
    operation,
    code: sanitizeDiagnostic(error.code),
    constraint: extractConstraintName(error.message, error.details),
    message: sanitizeDiagnostic(error.message)?.slice(0, 240) ?? null,
  });
}

function extractConstraintName(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (!value) continue;
    const match = value.match(/constraint\s+["']([^"']+)["']/i);
    if (match) return match[1].slice(0, 160);
  }
  return null;
}

function sanitizeDiagnostic(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*)\S+/gi, "$1[redacted]")
    .trim()
    .slice(0, 500);
}

function sanitizeEventDetails(
  details: Record<string, string | number | boolean | null>,
) {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      !/^[a-z][a-z0-9_]{0,79}$/i.test(key) ||
      /(secret|password|token|key|authorization|cookie|session|reoon|raw|payload)/i.test(
        key,
      )
    ) {
      continue;
    }
    sanitized[key] =
      typeof value === "string" ? sanitizeDiagnostic(value)?.slice(0, 300) ?? "" : value;
  }
  return sanitized;
}

export async function refreshDiscoveryRunCounters(runId: string) {
  const supabase = getSupabaseAdmin();
  const [sources, companies] = await Promise.all([
    supabase.from("fev_500global_sources").select("processing_status").eq("run_id", runId),
    supabase
      .from("fev_500global_discovered_companies")
      .select("id, eligibility_status, review_status")
      .eq("run_id", runId),
  ]);
  if (sources.error || companies.error) {
    throw new DiscoveryError("Could not refresh discovery counters.", 500);
  }
  const sourceRows = sources.data ?? [];
  const companyRows = companies.data ?? [];
  const companyIds = companyRows.map((company) => company.id);
  const founders = companyIds.length
    ? await supabase
        .from("fev_500global_discovered_founders")
        .select("import_status")
        .in("company_id", companyIds)
    : { data: [], error: null };
  if (founders.error) {
    throw new DiscoveryError("Could not refresh discovery counters.", 500);
  }
  const founderRows = founders.data ?? [];
  const { error } = await supabase
    .from("fev_500global_runs")
    .update({
      total_sources: sourceRows.length,
      processed_sources: sourceRows.filter((row) =>
        ["processed", "needs_review", "error", "skipped"].includes(row.processing_status),
      ).length,
      discovered_companies: companyRows.length,
      eligible_companies: companyRows.filter((row) => row.eligibility_status === "eligible").length,
      review_companies: companyRows.filter((row) => row.eligibility_status === "needs_review").length,
      approved_companies: companyRows.filter((row) => row.review_status === "approved").length,
      rejected_companies: companyRows.filter((row) => row.review_status === "rejected").length,
      imported_founders: founderRows.filter((row) => row.import_status === "imported").length,
    })
    .eq("id", runId);
  if (error) throw new DiscoveryError(`Could not update discovery counters: ${error.message}`, 500);
}

export async function getDiscoveryFinderProgress(
  runId: string,
): Promise<DiscoveryFinderProgress> {
  const supabase = getSupabaseAdmin();
  const [runResult, sourceResult, companyResult] = await Promise.all([
    supabase.from("fev_500global_runs").select("status").eq("id", runId).maybeSingle(),
    supabase.from("fev_500global_sources").select("processing_status").eq("run_id", runId),
    supabase
      .from("fev_500global_discovered_companies")
      .select("eligibility_status, review_status")
      .eq("run_id", runId),
  ]);
  if (runResult.error || sourceResult.error || companyResult.error) {
    throw new DiscoveryError("Could not load discovery progress.", 500);
  }
  if (!runResult.data) throw new DiscoveryError("Discovery run not found.", 404);
  const sources = sourceResult.data ?? [];
  const companies = companyResult.data ?? [];
  const terminalStatuses = new Set(["processed", "needs_review", "error", "skipped"]);
  return {
    runStatus: runResult.data.status,
    totalSources: sources.length,
    processedSources: sources.filter((row) => terminalStatuses.has(row.processing_status)).length,
    pendingSources: sources.filter((row) =>
      row.processing_status === "pending" || row.processing_status === "processing",
    ).length,
    discoveredCompanies: companies.length,
    eligibleCompanies: companies.filter((row) => row.eligibility_status === "eligible").length,
    needsReviewCompanies: companies.filter((row) => row.eligibility_status === "needs_review").length,
    rejectedCompanies: companies.filter(
      (row) => row.eligibility_status === "ineligible" || row.review_status === "rejected",
    ).length,
  };
}

export async function pauseDiscoveryRun(runId: string) {
  const run = await requireMutableRun(runId);
  if (run.status === "paused") return getDiscoveryFinderProgress(runId);
  if (run.status !== "queued" && run.status !== "running") {
    return getDiscoveryFinderProgress(runId);
  }
  {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("fev_500global_runs")
      .update({ status: "paused" })
      .eq("id", runId);
    if (error) throw new DiscoveryError("Could not pause the run.", 500);
    await recordDiscoveryEvent(runId, "run_paused", "Lead finding paused.");
  }
  return getDiscoveryFinderProgress(runId);
}

export async function resumeDiscoveryRun(runId: string) {
  const run = await requireMutableRun(runId);
  if (run.status === "paused" || run.status === "review_ready" || run.status === "completed_with_errors") {
    const supabase = getSupabaseAdmin();
    if (run.status === "completed_with_errors") {
      const { error: sourceError } = await supabase
        .from("fev_500global_sources")
        .update({
          processing_status: "pending",
          next_retry_at: null,
          lease_token: null,
          lease_expires_at: null,
          last_error: null,
        })
        .eq("run_id", runId)
        .eq("official_evidence", true)
        .eq("processing_status", "error");
      if (sourceError) throw new DiscoveryError("Could not re-queue failed official sources.", 500);
    }
    const { error } = await supabase
      .from("fev_500global_runs")
      .update({ status: "queued", completed_at: null })
      .eq("id", runId);
    if (error) throw new DiscoveryError("Could not resume the run.", 500);
    await recordDiscoveryEvent(runId, "run_resumed", "Lead finding resumed.");
    await refreshDiscoveryRunCounters(runId);
  }
  return getDiscoveryFinderProgress(runId);
}

export async function getDiscoveryEnrichmentProgress(
  runId: string,
): Promise<DiscoveryEnrichmentProgress> {
  await requireRun(runId);
  const supabase = getSupabaseAdmin();
  const companyResult = await supabase
    .from("fev_500global_discovered_companies")
    .select("id, eligibility_status, enrichment_status, enrichment_attempts")
    .eq("run_id", runId);
  if (companyResult.error) {
    throw new DiscoveryError("Could not load enrichment progress.", 500);
  }
  const companies = companyResult.data ?? [];
  const founderResult = companies.length
    ? await supabase
        .from("fev_500global_discovered_founders")
        .select("id, company_id")
        .in("company_id", companies.map((company) => company.id))
    : { data: [], error: null };
  if (founderResult.error) {
    throw new DiscoveryError("Could not load enrichment founder progress.", 500);
  }
  const terminal = new Set(["enriched", "skipped", "error"]);
  return {
    totalCompanies: companies.length,
    checkedCompanies: companies.filter(
      (company) => terminal.has(company.enrichment_status) || company.enrichment_attempts > 0,
    ).length,
    pendingCompanies: companies.filter(
      (company) =>
        company.enrichment_status === "pending" ||
        company.enrichment_status === "processing" ||
        (company.enrichment_status === "needs_review" && company.enrichment_attempts === 0),
    ).length,
    eligibleCompanies: companies.filter((company) => company.eligibility_status === "eligible").length,
    needsReviewCompanies: companies.filter(
      (company) => company.eligibility_status === "needs_review",
    ).length,
    ineligibleCompanies: companies.filter(
      (company) => company.eligibility_status === "ineligible",
    ).length,
    foundersFound: (founderResult.data ?? []).length,
  };
}

export async function recalculateCompanyEligibility(runId: string, companyId: string) {
  const supabase = getSupabaseAdmin();
  const [companyResult, founderResult, runResult, evidenceResult] = await Promise.all([
    supabase.from("fev_500global_discovered_companies").select("*").eq("id", companyId).eq("run_id", runId).single(),
    supabase.from("fev_500global_discovered_founders").select("*").eq("company_id", companyId),
    supabase.from("fev_500global_runs").select("target_years, target_regions").eq("id", runId).single(),
    supabase
      .from("fev_500global_evidence")
      .select("founder_id, evidence_type, authority, normalized_value, supports_claim")
      .eq("run_id", runId)
      .eq("company_id", companyId),
  ]);
  if (companyResult.error || founderResult.error || runResult.error || evidenceResult.error) {
    throw new DiscoveryError("Could not validate company eligibility.", 500);
  }
  const source = await supabase
    .from("fev_500global_sources")
    .select("approval_status")
    .eq("id", companyResult.data.primary_source_id)
    .single();
  if (source.error) throw new DiscoveryError("Could not validate source approval.", 500);

  const company = companyResult.data;
  const summary = jsonObject(company.evidence_summary);
  const country = company.headquarters_iso2
    ? resolveCountry(company.headquarters_iso2)
    : company.headquarters_country
      ? resolveCountry(company.headquarters_country)
      : null;
  const locationResolution = parseLocationResolution(summary.location_resolution);
  const founderEvidenceIds = new Set(
    (evidenceResult.data ?? [])
      .filter(
        (evidence) =>
          evidence.founder_id &&
          evidence.authority === "company_official" &&
          evidence.evidence_type === "founder_identity" &&
          evidence.supports_claim,
      )
      .map((evidence) => evidence.founder_id as string),
  );
  const activeFounderFound = (founderResult.data ?? []).some(
    (founder) =>
      founder.active_status === "confirmed" &&
      Boolean(normalizeFounderName(founder.founder_name)) &&
      founderEvidenceIds.has(founder.id),
  );
  const evaluation = evaluateDiscoveryEligibility({
    hasUsableDomain: Boolean(company.normalized_domain),
    acceleratorYearAllowed: Boolean(
      company.accelerator_year &&
        runResult.data.target_years.includes(company.accelerator_year),
    ),
    sourceApproved: source.data.approval_status === "approved",
    locationResolution,
    locationCountry: country?.canonicalName ?? company.headquarters_country,
    locationRegion: country?.region ?? null,
    targetRegions: runResult.data.target_regions,
    hasEvidenceBackedActiveFounder: activeFounderFound,
  });
  const eligibility = evaluation.status;
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .update({
      eligibility_status: eligibility,
      eligibility_reasons: evaluation.reasons,
      ...(company.review_status === "pending" && eligibility !== "eligible"
        ? { import_status: "not_ready" as const }
        : {}),
    })
    .eq("id", companyId);
  if (error) throw new DiscoveryError(`Could not save eligibility: ${error.message}`, 500);
  return eligibility;
}

export async function requireRun(runId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new DiscoveryError(`Could not load the run: ${error.message}`, 500);
  if (!data) throw new DiscoveryError("Discovery run not found.", 404);
  return data;
}

export async function requireMutableRun(runId: string) {
  const run = await requireRun(runId);
  if (run.imported_batch_id || run.status === "completed") {
    throw new DiscoveryError("This run has already been imported and is read-only.", 409);
  }
  return run;
}

async function requireMutableCompany(runId: string, companyId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_discovered_companies")
    .select("*")
    .eq("id", companyId)
    .eq("run_id", runId)
    .maybeSingle();
  if (error) throw new DiscoveryError(`Could not load the company: ${error.message}`, 500);
  if (!data) throw new DiscoveryError("Discovery company not found.", 404);
  if (data.import_status === "imported" || data.imported_batch_id) {
    throw new DiscoveryError("Imported company records are read-only.", 409);
  }
  return data;
}

async function requireMutableFounder(runId: string, founderId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_discovered_founders")
    .select("*")
    .eq("id", founderId)
    .maybeSingle();
  if (error) throw new DiscoveryError(`Could not load the founder: ${error.message}`, 500);
  if (!data) throw new DiscoveryError("Discovery founder not found.", 404);
  if (data.import_status === "imported" || data.imported_fev_founder_id) {
    throw new DiscoveryError("Imported founder records are read-only.", 409);
  }
  const { data: company, error: companyError } = await supabase
    .from("fev_500global_discovered_companies")
    .select("run_id, import_status, imported_batch_id")
    .eq("id", data.company_id)
    .maybeSingle();
  if (companyError) throw new DiscoveryError("Could not validate the founder's run.", 500);
  if (!company || company.run_id !== runId) {
    throw new DiscoveryError("Discovery founder not found.", 404);
  }
  if (company.import_status === "imported" || company.imported_batch_id) {
    throw new DiscoveryError("Founders on an imported company are read-only.", 409);
  }
  return data;
}

async function getCompanyWithFounders(companyId: string) {
  const supabase = getSupabaseAdmin();
  const [company, founders] = await Promise.all([
    supabase.from("fev_500global_discovered_companies").select("*").eq("id", companyId).single(),
    supabase.from("fev_500global_discovered_founders").select("*").eq("company_id", companyId),
  ]);
  if (company.error || founders.error) throw new DiscoveryError("Could not reload company data.", 500);
  return { ...company.data, founders: founders.data ?? [] };
}

function parseNumberSelection(value: unknown, allowed: Set<number>) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !allowed.has(item))
  ) {
    return null;
  }
  return [...new Set(value as number[])];
}

function parseStringSelection(value: unknown, allowed: Set<string>) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !allowed.has(item))
  ) {
    return null;
  }
  return [...new Set(value as string[])];
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new DiscoveryError(`${label} is required.`, 400);
  if (text.length > maxLength) throw new DiscoveryError(`${label} is too long.`, 400);
  return text;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new DiscoveryError("Invalid text value.", 400);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw new DiscoveryError("Text value is too long.", 400);
  return text;
}

function optionalYear(value: unknown, required = false) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new DiscoveryError("Accelerator year is required.", 400);
    return null;
  }
  const year = value === 2025 || value === "2025" ? 2025 : value === 2026 || value === "2026" ? 2026 : null;
  if (!year) {
    throw new DiscoveryError("Accelerator year must be 2025 or 2026.", 400);
  }
  return year;
}

function jsonObject(value: Database["public"]["Tables"]["fev_500global_discovered_companies"]["Row"]["evidence_summary"]) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeJsonObject(
  value: Database["public"]["Tables"]["fev_500global_discovered_companies"]["Row"]["evidence_summary"],
  additions: Record<string, unknown>,
) {
  return { ...jsonObject(value), ...additions } as Database["public"]["Tables"]["fev_500global_discovered_companies"]["Row"]["evidence_summary"];
}

function parseLocationResolution(value: unknown): LocationResolution {
  if (value === "manual_confirmed") return "confirmed";
  if (
    value === "missing" ||
    value === "provisional" ||
    value === "confirmed" ||
    value === "conflicting"
  ) {
    return value;
  }
  return "missing";
}
