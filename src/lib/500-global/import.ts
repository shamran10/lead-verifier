import "server-only";

import { DiscoveryError } from "@/lib/500-global/types";
import {
  recordDiscoveryEvent,
  refreshDiscoveryRunCounters,
} from "@/lib/500-global/repository";
import { duplicateKey, normalizeFounderName } from "@/lib/founder-normalization";
import { importFounderBatch } from "@/lib/import-batch";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ParsedFounder } from "@/lib/types";

const QUERY_CHUNK_SIZE = 100;

export async function importApprovedDiscoveryRun(runId: string) {
  const supabase = getSupabaseAdmin();
  const { data: run, error: runError } = await supabase
    .from("fev_500global_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw new DiscoveryError("Could not load the discovery run.", 500);
  if (!run) throw new DiscoveryError("Discovery run not found.", 404);
  if (run.dry_run) {
    throw new DiscoveryError("Dry-run discovery runs cannot be imported.", 409);
  }
  if (run.imported_batch_id) {
    return {
      batchId: run.imported_batch_id,
      insertedCount: run.imported_founders,
      duplicateCount: 0,
      reusedExistingBatch: true,
    };
  }

  const { data: companies, error: companyError } = await supabase
    .from("fev_500global_discovered_companies")
    .select("*")
    .eq("run_id", runId)
    .eq("review_status", "approved")
    .eq("eligibility_status", "eligible");
  if (companyError) throw new DiscoveryError("Could not load approved companies.", 500);
  if (!companies?.length) {
    throw new DiscoveryError("There are no approved, eligible companies to import.", 409);
  }

  const companyIds = companies.map((company) => company.id);
  const { data: founders, error: founderError } = await supabase
    .from("fev_500global_discovered_founders")
    .select("*")
    .in("company_id", companyIds)
    .eq("review_status", "approved")
    .eq("active_status", "confirmed")
    .eq("include_in_import", true)
    .order("created_at", { ascending: true });
  if (founderError) throw new DiscoveryError("Could not load approved founders.", 500);
  if (!founders?.length) {
    throw new DiscoveryError("There are no approved, included founders to import.", 409);
  }

  const companyById = new Map(companies.map((company) => [company.id, company]));
  const parsed: ParsedFounder[] = founders.map((founder, index) => {
    const company = companyById.get(founder.company_id);
    if (
      !company ||
      !company.website ||
      !company.normalized_domain ||
      !company.headquarters_country ||
      !company.accelerator_year ||
      !company.accelerator_region
    ) {
      throw new DiscoveryError("An approved company is missing required import metadata.", 409);
    }
    const normalized = normalizeFounderName(founder.founder_name);
    if (!normalized) {
      throw new DiscoveryError("An approved founder has an unusable name.", 409);
    }
    const firstCandidate = `${normalized.firstName}@${company.normalized_domain}`;
    const lastCandidate = normalized.lastName
      ? `${normalized.lastName}@${company.normalized_domain}`
      : null;
    return {
      sourceSheetName: "500 Global Discovery",
      sourceRow: index + 2,
      companyName: company.company_name,
      website: company.website,
      normalizedDomain: company.normalized_domain,
      ycBatch: null,
      acceleratorName: "500 Global",
      acceleratorBatch: company.accelerator_batch,
      acceleratorYear: company.accelerator_year,
      acceleratorRegion: company.accelerator_region,
      sourceUrl: company.source_url,
      industry: company.industry,
      description: company.description,
      country: company.headquarters_country,
      founderName: founder.founder_name,
      normalizedFounderName: normalized.normalizedFounderName,
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      founderRole: founder.founder_role,
      linkedinUrl: founder.linkedin_url,
      firstCandidateEmail: firstCandidate,
      lastCandidateEmail: lastCandidate && lastCandidate !== firstCandidate ? lastCandidate : null,
    };
  });

  try {
    const { error: importingError } = await supabase
      .from("fev_500global_runs")
      .update({ status: "importing", last_error: null })
      .eq("id", runId);
    if (importingError) throw new Error("Could not start the discovery import.");
    await recordDiscoveryEvent(runId, "import_started", "Approved-record import started.");

    const result = await importFounderBatch({
      batchName: run.name,
      sourceFileName: `500-global-discovery-${run.id}.json`,
      sourceType: "500_global",
      founders: parsed,
      discoveryRunId: runId,
    });

    const importedByKey = await loadImportedBatchFounders(result.batchId);
    const existingByKey = await loadExistingFounders(parsed);
    let duplicateCount = 0;
    const seenKeys = new Set<string>();
    for (const founder of founders) {
      const normalized = normalizeFounderName(founder.founder_name);
      const company = companyById.get(founder.company_id);
      if (!normalized || !company?.normalized_domain) continue;
      const key = duplicateKey(normalized.normalizedFounderName, company.normalized_domain);
      const repeatedInRun = seenKeys.has(key);
      seenKeys.add(key);
      const imported = repeatedInRun ? undefined : importedByKey.get(key);
      const existing = imported ?? existingByKey.get(key);
      const isImportedIntoBatch = Boolean(imported);
      if (!isImportedIntoBatch) duplicateCount += 1;
      const { error } = await supabase
        .from("fev_500global_discovered_founders")
        .update({
          duplicate_status: isImportedIntoBatch
            ? "new"
            : repeatedInRun
              ? "same_run"
              : existing?.source_type === "yc"
              ? "existing_yc"
              : "existing_500_global",
          import_status: isImportedIntoBatch ? "imported" : "duplicate",
          existing_fev_founder_id: isImportedIntoBatch ? null : existing?.id ?? null,
          imported_fev_founder_id: imported?.id ?? null,
          imported_at: new Date().toISOString(),
        })
        .eq("id", founder.id);
      if (error) throw new Error("Could not reconcile a discovery founder.");
      if (!isImportedIntoBatch) {
        await recordDiscoveryEvent(runId, "duplicate_skipped", "Duplicate founder skipped during import.", {
          companyId: founder.company_id,
          founderId: founder.id,
        });
      }
    }

    const now = new Date().toISOString();
    const importedCompanyIds = new Set(founders.map((founder) => founder.company_id));
    if (importedCompanyIds.size) {
      const { error: companyImportError } = await supabase
        .from("fev_500global_discovered_companies")
        .update({
          import_status: "imported",
          imported_batch_id: result.batchId,
          imported_at: now,
        })
        .in("id", [...importedCompanyIds]);
      if (companyImportError) throw new Error("Could not link imported companies.");
    }
    const { error: completionError } = await supabase
      .from("fev_500global_runs")
      .update({
        status: "completed",
        imported_batch_id: result.batchId,
        imported_founders: result.insertedCount,
        completed_at: now,
        last_error: null,
      })
      .eq("id", runId);
    if (completionError) throw new Error("Could not complete the discovery import.");
    try {
      await Promise.all([
        recordDiscoveryEvent(runId, "import_completed", "Approved-record import completed."),
        refreshDiscoveryRunCounters(runId),
      ]);
    } catch {
      // The linked batch and imported records are authoritative after commit.
    }
    return {
      batchId: result.batchId,
      insertedCount: result.insertedCount,
      duplicateCount,
      reusedExistingBatch: result.reusedExistingBatch,
    };
  } catch (error) {
    await supabase
      .from("fev_500global_runs")
      .update({ status: "review_ready", last_error: "Discovery import failed." })
      .eq("id", runId);
    try {
      await recordDiscoveryEvent(runId, "import_failure", "Approved-record import failed.", {
        level: "error",
      });
    } catch {
      // Preserve the import error when event persistence also fails.
    }
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError("Could not import approved discovery records.", 500);
  }
}

async function loadImportedBatchFounders(batchId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_founders")
    .select("id, normalized_founder_name, normalized_domain")
    .eq("batch_id", batchId);
  if (error) throw new Error("Could not reconcile imported founders.");
  return new Map(
    (data ?? []).map((founder) => [
      duplicateKey(founder.normalized_founder_name, founder.normalized_domain),
      { ...founder, source_type: "500_global" as const },
    ]),
  );
}

async function loadExistingFounders(founders: ParsedFounder[]) {
  const supabase = getSupabaseAdmin();
  const names = [...new Set(founders.map((founder) => founder.normalizedFounderName))];
  const records = new Map<
    string,
    { id: string; source_type: "yc" | "500_global" }
  >();
  for (let index = 0; index < names.length; index += QUERY_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("fev_founders")
      .select("id, normalized_founder_name, normalized_domain, fev_batches!inner(source_type)")
      .in("normalized_founder_name", names.slice(index, index + QUERY_CHUNK_SIZE));
    if (error) throw new Error("Could not reconcile existing founders.");
    for (const founder of data ?? []) {
      records.set(
        duplicateKey(founder.normalized_founder_name, founder.normalized_domain),
        {
          id: founder.id,
          source_type: founder.fev_batches.source_type,
        },
      );
    }
  }
  return records;
}
