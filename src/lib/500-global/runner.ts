import "server-only";

import { randomUUID } from "node:crypto";

import { extractOfficialParticipants, type ExtractedParticipant } from "@/lib/500-global/extract";
import { DiscoveryFetchError, fetchOfficialDiscoveryHtml } from "@/lib/500-global/fetch";
import {
  addDiscoverySource,
  getDiscoveryFinderProgress,
  recordDiscoveryEvent,
  recordDiscoveryEventOnce,
  refreshDiscoveryRunCounters,
  requireMutableRun,
} from "@/lib/500-global/repository";
import {
  getCatalogCoverageWarnings,
  getOfficialDiscoverySource,
  selectOfficialDiscoverySources,
} from "@/lib/500-global/source-catalog";
import {
  DiscoveryError,
  type DiscoveryEvidenceAuthority,
  type DiscoveryEvidenceType,
  type DiscoveryNextResult,
  type DiscoverySeedResult,
} from "@/lib/500-global/types";
import { normalizeFounderName } from "@/lib/founder-normalization";
import { evaluateDiscoveryEligibility } from "@/lib/500-global/eligibility";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { Database, Json } from "@/lib/database.types";

const LEASE_MS = 2 * 60 * 1000;
const SANITIZED_ERROR_LENGTH = 400;
const EVIDENCE_AUTHORITY: DiscoveryEvidenceAuthority =
  "500_global_official";
const OFFICIAL_MEMBERSHIP_EVIDENCE_TYPE: DiscoveryEvidenceType =
  "official_membership";

type SourceRow = Database["public"]["Tables"]["fev_500global_sources"]["Row"];
type CompanyRow = Database["public"]["Tables"]["fev_500global_discovered_companies"]["Row"];
type CandidatePersistenceOutcome =
  | "inserted_with_evidence"
  | "existing_evidence_added"
  | "already_complete"
  | "duplicate_domain"
  | "duplicate_name"
  | "invalid_website"
  | "evidence_error"
  | "database_error";

type CandidateOutcome = {
  candidate_index: number;
  company_name: string;
  normalized_domain: string | null;
  outcome: CandidatePersistenceOutcome;
  reason: string | null;
};

class EvidencePersistenceError extends DiscoveryError {}

export async function seedOfficialDiscoverySources(
  runId: string,
): Promise<DiscoverySeedResult> {
  const run = await requireMutableRun(runId);
  const catalog = selectOfficialDiscoverySources(run.target_years, run.target_regions);
  const warnings = getCatalogCoverageWarnings(run.target_years);
  let addedSources = 0;
  let skippedSources = 0;
  let retriedSources = 0;
  const supabase = getSupabaseAdmin();

  for (const source of catalog) {
    const { data: existing, error: existingError } = await supabase
      .from("fev_500global_sources")
      .select("id, processing_status")
      .eq("run_id", runId)
      .eq("normalized_url", source.url)
      .maybeSingle();
    if (existingError) throw new DiscoveryError("Could not inspect existing discovery sources.", 500);
    if (existing) {
      skippedSources += 1;
      const recheckFinishedSource =
        (run.status === "review_ready" ||
          run.status === "completed_with_errors") &&
        (existing.processing_status === "processed" ||
          existing.processing_status === "needs_review");
      if (existing.processing_status === "error" || recheckFinishedSource) {
        const { error } = await supabase
          .from("fev_500global_sources")
          .update({
            processing_status: "pending",
            next_retry_at: null,
            lease_token: null,
            lease_expires_at: null,
            last_error: null,
          })
          .eq("id", existing.id)
          .eq("processing_status", existing.processing_status);
        if (error) throw new DiscoveryError("Could not re-queue the failed official source.", 500);
        retriedSources += 1;
        await recordDiscoveryEventOnce(
          runId,
          "source_retry_queued",
          "The verified official source was re-queued for a safe check.",
          { sourceId: existing.id },
        );
      }
      continue;
    }
    try {
      await addDiscoverySource(runId, {
        url: source.url,
        sourceKind: source.sourceKind,
        acceleratorBatch: source.acceleratorBatch,
        acceleratorYear: source.acceleratorYear,
        approvePartnerHost: false,
      });
      addedSources += 1;
    } catch (error) {
      if (error instanceof DiscoveryError && error.status === 409) continue;
      throw error;
    }
  }

  if (
    (addedSources > 0 || retriedSources > 0) &&
    (run.status === "draft" || run.status === "review_ready" || run.status === "completed_with_errors")
  ) {
    const { error } = await supabase
      .from("fev_500global_runs")
      .update({ status: "queued", completed_at: null, last_error: null })
      .eq("id", runId);
    if (error) throw new DiscoveryError("Could not queue the discovery run.", 500);
  }
  for (const warning of warnings) {
    await recordDiscoveryEventOnce(runId, "catalog_coverage_warning", warning, {
      level: "warning",
    });
  }
  await refreshDiscoveryRunCounters(runId);
  return {
    addedSources,
    skippedSources,
    warnings,
    progress: await getDiscoveryFinderProgress(runId),
  };
}

export async function processNextDiscoverySource(
  runId: string,
): Promise<DiscoveryNextResult> {
  const run = await requireMutableRun(runId);
  if (run.status === "paused") return result(runId, "paused", "Lead finding is paused.");

  await reclaimExpiredLeases(runId);
  const source = await reserveNextSource(runId);
  if (!source) return finalizeOrWait(runId);

  const supabase = getSupabaseAdmin();
  if (run.status !== "running") {
    const { error } = await supabase
      .from("fev_500global_runs")
      .update({ status: "running", started_at: run.started_at ?? new Date().toISOString() })
      .eq("id", runId)
      .neq("status", "paused");
    if (error) throw new DiscoveryError("Could not start the discovery run.", 500);
  }

  try {
    const fetched = await fetchOfficialDiscoveryHtml(source.url, {
      runId,
      sourceId: source.id,
    });
    const catalogSource = getOfficialDiscoverySource(source.normalized_url);
    const extraction = extractOfficialParticipants(fetched.html, fetched.finalUrl, {
      strategy: catalogSource?.extractorStrategy ?? "participant_list",
      expectedMinimumCompanies: catalogSource?.expectedMinimumCompanies ?? 1,
      expectedApproximateCompanies: catalogSource?.expectedApproximateCompanies,
    });
    const { error: metadataError } = await supabase
      .from("fev_500global_sources")
      .update({
        url: fetched.finalUrl,
        page_title: extraction.pageTitle,
        published_date: extraction.publishedDate,
        robots_allowed: true,
        robots_checked_at: fetched.robotsCheckedAt,
        http_status: fetched.status,
        content_type: fetched.contentType,
        content_hash: fetched.contentHash,
        etag: fetched.etag,
        last_modified: fetched.lastModified,
        response_metadata: {
          redirected: fetched.finalUrl !== source.url,
          redirect_count: fetched.redirectCount,
          final_hostname: new URL(fetched.finalUrl).hostname,
        },
        extracted_payload: {
          ...extraction.diagnostics,
          inserted_companies: 0,
          existing_companies: 0,
          inserted_with_evidence: 0,
          existing_evidence_added: 0,
          already_complete: 0,
          duplicate_domain: 0,
          duplicate_name: 0,
          invalid_website: 0,
          evidence_errors: 0,
          database_errors: 0,
          inserted_founders: 0,
          outcomes: [],
          warning_count: extraction.warnings.length,
        },
        fetched_at: fetched.fetchedAt,
      })
      .eq("id", source.id)
      .eq("lease_token", source.lease_token ?? "");
    if (metadataError) throw new DiscoveryError("Could not save safe source metadata.", 500);
    const currentRun = await requireMutableRun(runId);
    const persistence = await persistParticipants(
      currentRun,
      source,
      extraction.participants,
      {
        finalUrl: fetched.finalUrl,
        pageTitle: extraction.pageTitle,
        contentHash: fetched.contentHash,
        observedAt: fetched.fetchedAt,
      },
    );
    const warnings = [...extraction.warnings, ...persistence.warnings];
    const hasPersistenceErrors =
      persistence.evidenceErrors > 0 || persistence.databaseErrors > 0;
    const processingStatus = hasPersistenceErrors
      ? "error"
      : extraction.participants.length
        ? "processed"
        : "needs_review";
    const { error } = await supabase
      .from("fev_500global_sources")
      .update({
        url: fetched.finalUrl,
        processing_status: processingStatus,
        page_title: extraction.pageTitle,
        published_date: extraction.publishedDate,
        robots_allowed: true,
        robots_checked_at: fetched.robotsCheckedAt,
        http_status: fetched.status,
        content_type: fetched.contentType,
        content_hash: fetched.contentHash,
        etag: fetched.etag,
        last_modified: fetched.lastModified,
        response_metadata: {
          redirected: fetched.finalUrl !== source.url,
          redirect_count: fetched.redirectCount,
          final_hostname: new URL(fetched.finalUrl).hostname,
        },
        extracted_payload: {
          ...extraction.diagnostics,
          accepted_companies: extraction.participants.length,
          inserted_companies: persistence.insertedCompanies,
          existing_companies: persistence.existingCompanies,
          inserted_with_evidence: persistence.insertedWithEvidence,
          existing_evidence_added: persistence.existingEvidenceAdded,
          already_complete: persistence.alreadyComplete,
          duplicate_domain: persistence.duplicateDomain,
          duplicate_name: persistence.duplicateName,
          invalid_website: persistence.invalidWebsite,
          evidence_errors: persistence.evidenceErrors,
          database_errors: persistence.databaseErrors,
          inserted_founders: persistence.insertedFounders,
          outcomes: persistence.outcomes,
          warning_count: warnings.length,
        },
        next_retry_at: null,
        lease_token: null,
        lease_expires_at: null,
        fetched_at: fetched.fetchedAt,
        last_error: hasPersistenceErrors
          ? persistence.warnings.join(" ").slice(0, SANITIZED_ERROR_LENGTH)
          : null,
      })
      .eq("id", source.id)
      .eq("lease_token", source.lease_token ?? "");
    if (error) throw new DiscoveryError("Could not save source processing results.", 500);
    await recordDiscoveryEventOnce(
      runId,
      "source_processed",
      `Processed one official source and found ${extraction.participants.length} listed companies.`,
      {
        sourceId: source.id,
        level: warnings.length ? "warning" : "info",
        details: {
          participant_count: extraction.participants.length,
          inserted_companies: persistence.insertedCompanies,
          existing_companies: persistence.existingCompanies,
          existing_evidence_added: persistence.existingEvidenceAdded,
          already_complete: persistence.alreadyComplete,
          evidence_errors: persistence.evidenceErrors,
          database_errors: persistence.databaseErrors,
          inserted_founders: persistence.insertedFounders,
          warning_count: warnings.length,
        },
      },
    );
    await refreshDiscoveryRunCounters(runId);
    return result(runId, "processed", "One official source was processed.");
  } catch (error) {
    return handleSourceFailure(runId, source, error);
  }
}

async function reserveNextSource(runId: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fev_500global_sources")
    .select("*")
    .eq("run_id", runId)
    .eq("approval_status", "approved")
    .eq("processing_status", "pending")
    .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new DiscoveryError("Could not load the next discovery source.", 500);

  for (const candidate of data ?? []) {
    const leaseToken = randomUUID();
    const { data: reserved, error: reserveError } = await supabase
      .from("fev_500global_sources")
      .update({
        processing_status: "processing",
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
        attempt_count: candidate.attempt_count + 1,
        last_error: null,
      })
      .eq("id", candidate.id)
      .eq("processing_status", "pending")
      .select("*")
      .maybeSingle();
    if (reserveError) throw new DiscoveryError("Could not reserve the discovery source.", 500);
    if (reserved) return reserved;
  }
  return null;
}

async function reclaimExpiredLeases(runId: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fev_500global_sources")
    .select("id")
    .eq("run_id", runId)
    .eq("processing_status", "processing")
    .lt("lease_expires_at", now);
  if (error) throw new DiscoveryError("Could not inspect discovery leases.", 500);
  for (const source of data ?? []) {
    const { error: updateError } = await supabase
      .from("fev_500global_sources")
      .update({
        processing_status: "pending",
        lease_token: null,
        lease_expires_at: null,
        last_error: "An expired processing lease was safely re-queued.",
      })
      .eq("id", source.id)
      .eq("processing_status", "processing")
      .lt("lease_expires_at", now);
    if (updateError) throw new DiscoveryError("Could not reclaim an expired source lease.", 500);
    await recordDiscoveryEvent(
      runId,
      "source_lease_reclaimed",
      "An expired source lease was safely re-queued.",
      { sourceId: source.id, level: "warning" },
    );
  }
}

async function persistParticipants(
  run: Awaited<ReturnType<typeof requireMutableRun>>,
  source: SourceRow,
  participants: ExtractedParticipant[],
  evidence: {
    finalUrl: string;
    pageTitle: string | null;
    contentHash: string;
    observedAt: string;
  },
) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("fev_500global_discovered_companies")
    .select("*")
    .eq("run_id", run.id);
  if (existingError) throw new DiscoveryError("Could not check existing discovered companies.", 500);
  const existingRows = existing ?? [];
  const byDomain = new Map(existingRows.filter((row) => row.normalized_domain).map((row) => [row.normalized_domain, row]));
  const byName = new Map(existingRows.map((row) => [row.normalized_company_name, row]));
  let remaining = Math.max(0, run.max_records - existingRows.length);
  let insertedCompanies = 0;
  let existingCompanies = 0;
  let insertedWithEvidence = 0;
  let existingEvidenceAdded = 0;
  let alreadyComplete = 0;
  let duplicateDomain = 0;
  let duplicateName = 0;
  let invalidWebsite = 0;
  let evidenceErrors = 0;
  let databaseErrors = 0;
  let insertedFounders = 0;
  const warnings: string[] = [];
  const outcomes: CandidateOutcome[] = [];

  for (const [participantIndex, participant] of participants.entries()) {
    const candidateIndex = participantIndex + 1;
    const normalizedCompanyName = normalizeCompanyName(participant.companyName);
    if (!participant.normalizedDomain) {
      invalidWebsite += 1;
      outcomes.push(candidateOutcome(candidateIndex, participant, "invalid_website", "The listed website is not usable."));
      continue;
    }
    if (!normalizedCompanyName) {
      databaseErrors += 1;
      outcomes.push(candidateOutcome(candidateIndex, participant, "database_error", "The normalized company name is empty."));
      warnings.push(`Candidate ${candidateIndex} has no usable normalized company name.`);
      continue;
    }

    const domainMatch = byDomain.get(participant.normalizedDomain) ?? null;
    const nameMatch = byName.get(normalizedCompanyName) ?? null;
    if (domainMatch && domainMatch.normalized_company_name !== normalizedCompanyName) {
      duplicateDomain += 1;
      outcomes.push(candidateOutcome(candidateIndex, participant, "duplicate_domain", "The domain already belongs to another discovered company."));
      continue;
    }
    if (
      nameMatch &&
      nameMatch.normalized_domain !== participant.normalizedDomain
    ) {
      duplicateName += 1;
      outcomes.push(candidateOutcome(candidateIndex, participant, "duplicate_name", "The normalized name already belongs to another discovered company."));
      continue;
    }

    let company = domainMatch ?? nameMatch;
    let insertedThisAttempt = false;
    if (!company && remaining <= 0) {
      warnings.push("The run reached its maximum record limit; remaining listed companies were not stored.");
      databaseErrors += 1;
      outcomes.push(candidateOutcome(candidateIndex, participant, "database_error", "The run reached its maximum record limit."));
      continue;
    }
    if (!company) {
      const eligibility = initialEligibility(run, participant);
      const { data: inserted, error } = await supabase
        .from("fev_500global_discovered_companies")
        .insert({
          run_id: run.id,
          primary_source_id: source.id,
          company_name: participant.companyName.slice(0, 200),
          normalized_company_name: normalizedCompanyName,
          website: participant.website,
          normalized_domain: participant.normalizedDomain,
          description: participant.description?.slice(0, 2000) ?? null,
          industry: participant.industry?.slice(0, 200) ?? null,
          headquarters_country:
            participant.resolvedCountry?.canonicalName ?? participant.countryText?.slice(0, 120) ?? null,
          headquarters_iso2: participant.resolvedCountry?.iso2 ?? null,
          accelerator_name: "500 Global",
          accelerator_batch: source.accelerator_batch,
          accelerator_year: source.accelerator_year,
          accelerator_region: participant.eligibleCountry?.region ?? null,
          source_url: evidence.finalUrl,
          eligibility_status: eligibility.status,
          review_status: "pending",
          import_status: "not_ready",
          enrichment_status: eligibility.status === "ineligible" ? "skipped" : "pending",
          eligibility_reasons: eligibility.reasons,
          warnings: participant.warnings,
          evidence_summary: {
            official_participant_source: evidence.finalUrl,
            roster_country: participant.resolvedCountry?.canonicalName ?? participant.countryText,
            roster_country_iso2: participant.resolvedCountry?.iso2 ?? null,
            location_resolution:
              participant.resolvedCountry?.region === null
                ? "confirmed"
                : participant.resolvedCountry
                  ? "provisional"
                  : "missing",
          },
        })
        .select("*")
        .single();
      if (error || !inserted) {
        logSupabasePersistenceError(
          "fev_500global_discovered_companies.insert",
          error,
        );
        databaseErrors += 1;
        outcomes.push(candidateOutcome(candidateIndex, participant, "database_error", "The company row could not be stored."));
        warnings.push(`Candidate ${candidateIndex} could not be stored.`);
        await recordCandidatePersistenceWarning(
          run.id,
          source.id,
          candidateIndex,
          participant,
          "database_error",
        );
        continue;
      }
      company = inserted;
      byName.set(normalizedCompanyName, company);
      if (company.normalized_domain) byDomain.set(company.normalized_domain, company);
      remaining -= 1;
      insertedThisAttempt = true;
    } else {
      existingCompanies += 1;
    }

    try {
      const evidenceOutcome = await insertCompanyEvidence(
        run.id,
        source.id,
        company,
        participant,
        evidence,
      );
      await insertRosterLocationEvidence(
        run.id,
        source.id,
        company,
        participant,
        evidence,
      );
      if (insertedThisAttempt) {
        insertedCompanies += 1;
        insertedWithEvidence += 1;
        outcomes.push(
          candidateOutcome(
            candidateIndex,
            participant,
            "inserted_with_evidence",
            null,
          ),
        );
      } else if (evidenceOutcome === "inserted") {
        existingEvidenceAdded += 1;
        outcomes.push(
          candidateOutcome(
            candidateIndex,
            participant,
            "existing_evidence_added",
            null,
          ),
        );
      } else {
        alreadyComplete += 1;
        outcomes.push(
          candidateOutcome(
            candidateIndex,
            participant,
            "already_complete",
            null,
          ),
        );
      }
    } catch (error) {
      evidenceErrors += 1;
      if (insertedThisAttempt) {
        const deleted = await deleteIncompleteCompany(run.id, company);
        if (deleted) {
          byName.delete(normalizedCompanyName);
          byDomain.delete(participant.normalizedDomain);
          remaining += 1;
        }
      } else {
        existingCompanies -= 1;
      }
      outcomes.push(candidateOutcome(candidateIndex, participant, "evidence_error", "Official participant evidence could not be stored."));
      warnings.push(`Candidate ${candidateIndex} could not be stored with official evidence.`);
      await recordCandidatePersistenceWarning(
        run.id,
        source.id,
        candidateIndex,
        participant,
        "evidence_error",
        insertedThisAttempt ? undefined : company.id,
      );
      if (!(error instanceof EvidencePersistenceError)) {
        logSupabasePersistenceError(
          "fev_500global_evidence.unexpected",
          error,
        );
      }
      continue;
    }

    try {
      insertedFounders += await insertFounders(
        run.id,
        source.id,
        company,
        participant,
        evidence,
      );
    } catch (error) {
      if (error instanceof EvidencePersistenceError) evidenceErrors += 1;
      else databaseErrors += 1;
      warnings.push(`Founder details for candidate ${candidateIndex} require review.`);
      await recordCandidatePersistenceWarning(
        run.id,
        source.id,
        candidateIndex,
        participant,
        error instanceof EvidencePersistenceError
          ? "evidence_error"
          : "database_error",
        company.id,
      );
    }
  }
  return {
    insertedCompanies,
    existingCompanies,
    insertedWithEvidence,
    existingEvidenceAdded,
    alreadyComplete,
    duplicateDomain,
    duplicateName,
    invalidWebsite,
    evidenceErrors,
    databaseErrors,
    insertedFounders,
    outcomes,
    warnings: [...new Set(warnings)],
  };
}

function candidateOutcome(
  candidateIndex: number,
  participant: ExtractedParticipant,
  outcome: CandidatePersistenceOutcome,
  reason: string | null,
): CandidateOutcome {
  return {
    candidate_index: candidateIndex,
    company_name: participant.companyName.slice(0, 200),
    normalized_domain: participant.normalizedDomain,
    outcome,
    reason,
  };
}

async function recordCandidatePersistenceWarning(
  runId: string,
  sourceId: string,
  candidateIndex: number,
  participant: ExtractedParticipant,
  outcome: "evidence_error" | "database_error",
  companyId?: string,
) {
  try {
    await recordDiscoveryEventOnce(
      runId,
      "candidate_persistence_warning",
      `Participant candidate ${candidateIndex} encountered a persistence warning.`,
      {
        sourceId,
        companyId,
        level: "warning",
        details: {
          candidate_index: candidateIndex,
          company_name: participant.companyName.slice(0, 200),
          normalized_domain: participant.normalizedDomain,
          outcome,
        },
      },
    );
  } catch {
    // Candidate processing remains independent when audit-event persistence fails.
  }
}

async function deleteIncompleteCompany(runId: string, company: CompanyRow) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .delete()
    .eq("id", company.id)
    .eq("run_id", runId);
  if (!error) return true;
  logSupabasePersistenceError(
    "fev_500global_discovered_companies.delete_incomplete",
    error,
  );
  const warning = "Official participant evidence is incomplete; retry before review.";
  await supabase
    .from("fev_500global_discovered_companies")
    .update({
      eligibility_status: "needs_review",
      warnings: [...new Set([...company.warnings, warning])],
      last_error: warning,
    })
    .eq("id", company.id)
    .eq("run_id", runId);
  return false;
}

function initialEligibility(
  run: Awaited<ReturnType<typeof requireMutableRun>>,
  participant: ExtractedParticipant,
) {
  const recognized = participant.resolvedCountry;
  return evaluateDiscoveryEligibility({
    hasUsableDomain: Boolean(participant.normalizedDomain),
    acceleratorYearAllowed: true,
    sourceApproved: true,
    locationResolution:
      recognized?.region === null
        ? "confirmed"
        : recognized
          ? "provisional"
          : "missing",
    locationRegion: recognized?.region ?? null,
    locationCountry: recognized?.canonicalName ?? participant.countryText,
    targetRegions: run.target_regions,
    hasEvidenceBackedActiveFounder: false,
  });
}

async function insertCompanyEvidence(
  runId: string,
  sourceId: string,
  company: CompanyRow,
  participant: ExtractedParticipant,
  evidence: {
    finalUrl: string;
    pageTitle: string | null;
    contentHash: string;
    observedAt: string;
  },
) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("fev_500global_evidence")
    .select("id")
    .eq("run_id", runId)
    .eq("company_id", company.id)
    .eq("source_id", sourceId)
    .eq("evidence_type", OFFICIAL_MEMBERSHIP_EVIDENCE_TYPE)
    .eq("evidence_url", evidence.finalUrl)
    .eq("normalized_value", company.normalized_company_name)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    logSupabasePersistenceError(
      "fev_500global_evidence.select_company",
      existingError,
      { sourceId, companyId: company.id },
    );
    throw new EvidencePersistenceError("Could not check company evidence.", 500);
  }
  if (existing) return "existing" as const;
  const { error } = await supabase.from("fev_500global_evidence").insert({
    run_id: runId,
    source_id: sourceId,
    company_id: company.id,
    evidence_type: OFFICIAL_MEMBERSHIP_EVIDENCE_TYPE,
    authority: EVIDENCE_AUTHORITY,
    evidence_url: evidence.finalUrl,
    page_title: evidence.pageTitle,
    snippet: participant.snippet.slice(0, 1000),
    observed_value: participant.companyName.slice(0, 500),
    normalized_value: company.normalized_company_name,
    supports_claim: true,
    confidence: 1,
    content_hash: evidence.contentHash,
    observed_at: evidence.observedAt,
  });
  if (error?.code === "23505") {
    const { data: racedEvidence, error: racedEvidenceError } = await supabase
      .from("fev_500global_evidence")
      .select("id")
      .eq("run_id", runId)
      .eq("company_id", company.id)
      .eq("source_id", sourceId)
      .eq("evidence_type", OFFICIAL_MEMBERSHIP_EVIDENCE_TYPE)
      .eq("evidence_url", evidence.finalUrl)
      .eq("normalized_value", company.normalized_company_name)
      .limit(1)
      .maybeSingle();
    if (!racedEvidenceError && racedEvidence) return "existing" as const;
  }
  if (error) {
    logSupabasePersistenceError(
      "fev_500global_evidence.insert_company",
      error,
      { sourceId, companyId: company.id },
    );
    throw new EvidencePersistenceError("Could not store company evidence.", 500);
  }
  return "inserted" as const;
}

async function insertRosterLocationEvidence(
  runId: string,
  sourceId: string,
  company: CompanyRow,
  participant: ExtractedParticipant,
  evidence: {
    finalUrl: string;
    pageTitle: string | null;
    contentHash: string;
    observedAt: string;
  },
) {
  const country = participant.resolvedCountry;
  if (!country) return;
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("fev_500global_evidence")
    .select("id")
    .eq("run_id", runId)
    .eq("source_id", sourceId)
    .eq("company_id", company.id)
    .eq("evidence_type", "headquarters")
    .eq("authority", EVIDENCE_AUTHORITY)
    .eq("evidence_url", evidence.finalUrl)
    .eq("normalized_value", country.iso2)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new EvidencePersistenceError("Could not check roster location evidence.", 500);
  }
  if (existing) return;
  const { error } = await supabase.from("fev_500global_evidence").insert({
    run_id: runId,
    source_id: sourceId,
    company_id: company.id,
    evidence_type: "headquarters",
    authority: EVIDENCE_AUTHORITY,
    evidence_url: evidence.finalUrl,
    page_title: evidence.pageTitle,
    snippet: `Official participant roster lists the company location as ${country.canonicalName}.`,
    observed_value: country.canonicalName,
    normalized_value: country.iso2,
    supports_claim: true,
    confidence: country.region ? 0.7 : 0.85,
    content_hash: evidence.contentHash,
    observed_at: evidence.observedAt,
  });
  if (error?.code === "23505") return;
  if (error) throw new EvidencePersistenceError("Could not store roster location evidence.", 500);
}

async function insertFounders(
  runId: string,
  sourceId: string,
  company: CompanyRow,
  participant: ExtractedParticipant,
  evidence: {
    finalUrl: string;
    pageTitle: string | null;
    contentHash: string;
    observedAt: string;
  },
) {
  if (!participant.founders.length) return 0;
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("fev_500global_discovered_founders")
    .select("normalized_founder_name")
    .eq("company_id", company.id);
  if (existingError) throw new DiscoveryError("Could not check discovered founders.", 500);
  const names = new Set((existing ?? []).map((founder) => founder.normalized_founder_name));
  let insertedCount = 0;
  for (const founder of participant.founders) {
    const normalized = normalizeFounderName(founder.name);
    if (!normalized || names.has(normalized.normalizedFounderName)) continue;
    const { data: inserted, error } = await supabase
      .from("fev_500global_discovered_founders")
      .insert({
        company_id: company.id,
        founder_name: founder.name.slice(0, 200),
        normalized_founder_name: normalized.normalizedFounderName,
        first_name: normalized.firstName,
        last_name: normalized.lastName,
        founder_role: founder.role,
        linkedin_url: founder.linkedinUrl,
        active_status: "possible",
        review_status: "pending",
        duplicate_status: "unchecked",
        import_status: "not_ready",
        include_in_import: false,
        warnings: ["Founder identity and current active status require operator confirmation."],
        evidence_summary: { official_source: evidence.finalUrl } as Json,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      if (error?.code === "23505") continue;
      throw new DiscoveryError("Could not store a discovered founder.", 500);
    }
    names.add(normalized.normalizedFounderName);
    const { data: existingEvidence, error: existingEvidenceError } = await supabase
      .from("fev_500global_evidence")
      .select("id")
      .eq("run_id", runId)
      .eq("company_id", company.id)
      .eq("founder_id", inserted.id)
      .eq("evidence_type", "founder_identity")
      .eq("evidence_url", evidence.finalUrl)
      .limit(1)
      .maybeSingle();
    if (existingEvidenceError) {
      logSupabasePersistenceError(
        "fev_500global_evidence.select_founder",
        existingEvidenceError,
      );
      throw new EvidencePersistenceError("Could not check founder evidence.", 500);
    }
    if (existingEvidence) continue;
    const { error: evidenceError } = await supabase.from("fev_500global_evidence").insert({
      run_id: runId,
      source_id: sourceId,
      company_id: company.id,
      founder_id: inserted.id,
      evidence_type: "founder_identity",
      authority: EVIDENCE_AUTHORITY,
      evidence_url: evidence.finalUrl,
      page_title: evidence.pageTitle,
      snippet: `${founder.name}${founder.role ? `, ${founder.role}` : ""}`.slice(0, 1000),
      observed_value: founder.name.slice(0, 500),
      normalized_value: normalized.normalizedFounderName,
      supports_claim: true,
      confidence: 0.8,
      content_hash: evidence.contentHash,
      observed_at: evidence.observedAt,
    });
    if (evidenceError) {
      logSupabasePersistenceError(
        "fev_500global_evidence.insert_founder",
        evidenceError,
      );
      const { error: cleanupError } = await supabase
        .from("fev_500global_discovered_founders")
        .delete()
        .eq("id", inserted.id)
        .eq("company_id", company.id);
      if (cleanupError) {
        logSupabasePersistenceError(
          "fev_500global_discovered_founders.delete_incomplete",
          cleanupError,
        );
      }
      throw new EvidencePersistenceError("Could not store founder evidence.", 500);
    }
    insertedCount += 1;
  }
  return insertedCount;
}

async function handleSourceFailure(
  runId: string,
  source: SourceRow,
  error: unknown,
): Promise<DiscoveryNextResult> {
  const supabase = getSupabaseAdmin();
  const fetchError = error instanceof DiscoveryFetchError ? error : null;
  const safeMessage = sanitizeOperationalError(error);
  if (fetchError?.kind === "retry") {
    const { error: updateError } = await supabase
      .from("fev_500global_sources")
      .update({
        processing_status: "pending",
        next_retry_at: fetchError.retryAt,
        http_status: fetchError.status,
        lease_token: null,
        lease_expires_at: null,
        last_error: safeMessage,
      })
      .eq("id", source.id)
      .eq("lease_token", source.lease_token ?? "");
    if (updateError) throw new DiscoveryError("Could not defer the source retry.", 500);
    await recordDiscoveryEventOnce(runId, "source_rate_limited", safeMessage, {
      sourceId: source.id,
      level: "warning",
    });
    await refreshDiscoveryRunCounters(runId);
    return result(runId, "deferred", safeMessage);
  }

  const processingStatus = fetchError?.kind === "blocked" || fetchError?.kind === "invalid" ? "skipped" : "error";
  const failureUpdate: Database["public"]["Tables"]["fev_500global_sources"]["Update"] = {
    processing_status: processingStatus,
    lease_token: null,
    lease_expires_at: null,
    last_error: safeMessage,
  };
  if (fetchError) {
    failureUpdate.robots_allowed = fetchError.robotsAllowed ?? (/robots/i.test(safeMessage) ? false : null);
    failureUpdate.robots_checked_at = fetchError.robotsCheckedAt;
    failureUpdate.http_status = fetchError.status;
  }
  const { error: updateError } = await supabase
    .from("fev_500global_sources")
    .update(failureUpdate)
    .eq("id", source.id)
    .eq("lease_token", source.lease_token ?? "");
  if (updateError) throw new DiscoveryError("Could not save the source failure.", 500);
  await recordDiscoveryEventOnce(runId, "source_processing_failed", safeMessage, {
    sourceId: source.id,
    level: processingStatus === "error" ? "error" : "warning",
  });
  await refreshDiscoveryRunCounters(runId);
  return result(runId, "processed", safeMessage);
}

async function finalizeOrWait(runId: string): Promise<DiscoveryNextResult> {
  const supabase = getSupabaseAdmin();
  const [{ data: run, error: runError }, { data: sources, error: sourceError }] = await Promise.all([
    supabase.from("fev_500global_runs").select("status").eq("id", runId).single(),
    supabase.from("fev_500global_sources").select("processing_status, next_retry_at").eq("run_id", runId),
  ]);
  if (runError || sourceError) throw new DiscoveryError("Could not finalize discovery progress.", 500);
  if (run.status === "paused") return result(runId, "paused", "Lead finding is paused.");
  const rows = sources ?? [];
  if (rows.some((source) => source.processing_status === "processing")) {
    return result(runId, "idle", "Another request is processing the next source.");
  }
  if (rows.some((source) => source.processing_status === "pending")) {
    return result(runId, "idle", "The remaining source is waiting for its safe retry time.");
  }
  const hasErrors = rows.some((source) => source.processing_status === "error");
  const status = hasErrors ? "completed_with_errors" : "review_ready";
  if (run.status === status) {
    return result(
      runId,
      "complete",
      hasErrors ? "Lead finding completed with warnings." : "Leads are ready for review.",
    );
  }
  const { error } = await supabase
    .from("fev_500global_runs")
    .update({ status, completed_at: new Date().toISOString() })
    .eq("id", runId)
    .neq("status", "paused");
  if (error) throw new DiscoveryError("Could not finalize the discovery run.", 500);
  await refreshDiscoveryRunCounters(runId);
  await recordDiscoveryEventOnce(
    runId,
    "source_discovery_completed",
    hasErrors ? "Lead finding completed with source errors." : "Lead finding is ready for review.",
    { level: hasErrors ? "warning" : "info" },
  );
  return result(runId, "complete", hasErrors ? "Lead finding completed with warnings." : "Leads are ready for review.");
}

async function result(
  runId: string,
  outcome: DiscoveryNextResult["outcome"],
  message: string,
): Promise<DiscoveryNextResult> {
  return { outcome, message, progress: await getDiscoveryFinderProgress(runId) };
}

function normalizeCompanyName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 200);
}

function logSupabasePersistenceError(
  operation: string,
  error: unknown,
  context: { sourceId?: string; companyId?: string } = {},
) {
  const candidate =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          details?: unknown;
          hint?: unknown;
        })
      : {};
  console.error("[500 Global discovery] Supabase operation failed", {
    operation,
    code: sanitizeDiagnostic(candidate.code),
    constraint: extractConstraintName(candidate.message, candidate.details),
    message: sanitizeDiagnostic(candidate.message)?.slice(0, 240) ?? null,
    source_id: context.sourceId ?? null,
    company_id: context.companyId ?? null,
  });
}

function extractConstraintName(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const match = value.match(/constraint\s+["']([^"']+)["']/i);
    if (match) return match[1].slice(0, 160);
  }
  return null;
}

function sanitizeDiagnostic(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .trim()
    .slice(0, 500);
}

function sanitizeOperationalError(error: unknown) {
  const message = error instanceof Error ? error.message : "The source could not be processed.";
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi, "$1[redacted]")
    .slice(0, SANITIZED_ERROR_LENGTH);
}
