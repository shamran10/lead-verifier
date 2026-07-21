import { createHash } from "node:crypto";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import {
  enrichStandaloneCompany,
  type CompanyEnrichmentResult,
} from "@/lib/500-global/company-enrichment";
import { SameHostRateLimiter } from "@/lib/500-global/rate-limiter";
import {
  DiscoveryFetchError,
  fetchCompanyEnrichmentHtml,
  fetchOfficialDiscoveryHtml,
  type SafeFetchTransportOptions,
} from "@/lib/500-global/safe-fetch";
import { antlerOptionsFingerprint, openAntlerCache } from "@/lib/antler/cache";
import { discoverAntlerSources } from "@/lib/antler/source-discovery";
import { MAINTAINED_ANTLER_SOURCES } from "@/lib/antler/source-catalog";
import { isRobotsDisallowedAntlerPath } from "@/lib/antler/source-policy";
import { validateAndExtractAntlerSource } from "@/lib/antler/source-validation";
import {
  filterAntlerCompany,
  mergeAntlerSourceResults,
  primaryParticipation,
} from "@/lib/antler/pipeline";
import {
  discoveredDatasetPath,
  filteredDatasetPath,
  readDiscoveredDocument,
  readFilteredDocument,
  writeStageDocument,
} from "@/lib/antler/staged-workflow";
import type {
  AntlerRegion,
  AntlerSourceCandidate,
  AntlerSourceResult,
  AntlerYear,
  BlockedAntlerSource,
  DiscoveredAntlerDocument,
  FilteredAntlerCompany,
  FilteredAntlerDocument,
} from "@/lib/antler/types";
import {
  toCompanyRow,
  writeAntlerCompanyWorkbook,
  writeAntlerFinalWorkbook,
  type AntlerReadyRow,
  type AntlerReviewRow,
} from "@/lib/antler/workbook";
import { resolveCountry } from "@/lib/geography";

export const ANTLER_MINIMUM_HOST_SPACING_MS = 10_000;
const CACHE_DIRECTORY = path.resolve(process.cwd(), ".cache", "antler");
const USER_AGENT = "FounderEmailVerifier/1.0 standalone-antler-lead-exporter";
const MAX_SOURCE_CANDIDATES = 100;

export type CliOptions = {
  stage: "discover" | "filter" | "enrich" | "all";
  years: AntlerYear[];
  regions: AntlerRegion[];
  resume: boolean;
  fresh: boolean;
  hostSpacingMs: number;
};

async function main() {
  loadEnvConfig(process.cwd());
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  console.log(`Antler exporter: stage=${options.stage} years=${options.years.join(",")} regions=${options.regions.join(",")} ${options.fresh ? "fresh" : options.resume ? "resume" : "standard"}`);
  if (options.stage === "discover" || options.stage === "all") await runDiscoverStage(options);
  if (options.stage === "filter" || options.stage === "all") await runFilterStage(options);
  if (options.stage === "enrich" || options.stage === "all") await runEnrichStage(options);
}

export async function runDiscoverStage(options: CliOptions) {
  console.log("\nStage 1/3 — discovering official Antler companies...");
  const cache = await openStageCache("discover", options);
  const discovery = await discoverAntlerSources({
    catalog: MAINTAINED_ANTLER_SOURCES.filter((source) =>
      !source.yearHint || options.years.includes(source.yearHint)),
    years: options.years,
  });
  const transport = createTransport(options);
  const results = await processSourceQueue(discovery.candidates, options, cache, transport);
  const merged = mergeAntlerSourceResults(results);
  const blocked = results.filter((result) =>
    result.status === "robots_blocked" || result.status === "failed" || result.status === "retry_wait",
  ).map(toBlockedSource);
  const rejected = results.filter((result) => result.status === "rejected").map(toBlockedSource);
  const recordCount = results.reduce((count, result) => count + result.companies.length, 0);
  const document: DiscoveredAntlerDocument = {
    schema_version: 1,
    stage: "discover",
    generated_at: new Date().toISOString(),
    years: [...options.years],
    companies: merged.companies,
    blocked_sources: blocked,
    rejected_sources: rejected,
    duplicate_audit: merged.duplicates,
    coverage_warnings: [
      ...discovery.warnings,
      "Coverage is best-effort and limited to verified official Antler sources currently discovered and supported by the exporter.",
      "Antler pages disallowed by robots.txt are retained for manual review and are never fetched.",
    ],
    source_summary: {
      sources_discovered: results.length,
      sources_validated: results.filter((result) => result.status === "validated").length,
      sources_blocked: blocked.length,
      official_company_records: recordCount,
      unique_companies: merged.companies.length,
      duplicates_merged: merged.duplicates.length,
    },
  };
  await writeStageDocument(discoveredDatasetPath(), document);
  console.log(`Stage 1 complete: ${document.companies.length} unique companies from ${document.source_summary.sources_validated} validated sources.`);
  console.log(`Output: ${discoveredDatasetPath()}`);
  return document;
}

export async function runFilterStage(options: CliOptions) {
  console.log("\nStage 2/3 — filtering Antler companies by company location...");
  const discovered = await readDiscoveredDocument();
  assertYears(discovered.years, options.years);
  const cache = await openStageCache("filter", options);
  const transport = createTransport(options);
  const companies: FilteredAntlerCompany[] = [];
  for (const company of discovered.companies) {
    const key = companyKey(company.company_name, company.normalized_domain);
    let enrichment = cache.get<CompanyEnrichmentResult>("companies", key)?.value ?? null;
    if (!enrichment) {
      cache.markProcessing("companies", key);
      await cache.save();
      try {
        enrichment = await locationEnrichment(company, transport);
      } catch (error) {
        enrichment = failedCompanyEnrichment(company.company_name, company.website, error);
      }
      cache.set("companies", key, "completed", enrichment);
      await cache.save();
    }
    companies.push(filterAntlerCompany(company, enrichment, options.regions));
  }
  const document: FilteredAntlerDocument = {
    schema_version: 1,
    stage: "filter",
    generated_at: new Date().toISOString(),
    years: [...options.years],
    regions: [...options.regions],
    companies,
    blocked_sources: discovered.blocked_sources,
    rejected_sources: discovered.rejected_sources,
    duplicate_audit: discovered.duplicate_audit,
    coverage_warnings: discovered.coverage_warnings,
  };
  await writeStageDocument(filteredDatasetPath(), document);
  const outputPath = path.resolve(process.cwd(), "exports", "Antler_2025_2026_Companies.xlsx");
  const summary = await writeAntlerCompanyWorkbook(document, outputPath);
  console.log(`Stage 2 complete: ${summary.eligible} eligible, ${summary.unresolved} unresolved, ${summary.excluded} excluded.`);
  console.log(`Output: ${outputPath}`);
  return document;
}

export async function runEnrichStage(options: CliOptions) {
  console.log("\nStage 3/3 — enriching eligible Antler companies with founders...");
  const filtered = await readFilteredDocument();
  assertYears(filtered.years, options.years);
  const cache = await openStageCache("enrich", options);
  const transport = createTransport(options);
  const ready: AntlerReadyRow[] = [];
  const needsReview: AntlerReviewRow[] = [];
  for (const company of filtered.companies.filter(isEligible)) {
    const key = companyKey(company.company_name, company.normalized_domain);
    let enrichment = cache.get<CompanyEnrichmentResult>("companies", key)?.value ?? null;
    if (!enrichment) {
      cache.markProcessing("companies", key);
      await cache.save();
      try {
        enrichment = await founderEnrichment(company, transport);
      } catch (error) {
        enrichment = failedCompanyEnrichment(company.company_name, company.website, error);
      }
      cache.set("companies", key, "completed", enrichment);
      await cache.save();
    }
    const founders = enrichment.activeFounders.filter((founder) =>
      founder.activeStatus === "confirmed" && founder.name.trim().split(/\s+/).length >= 2,
    ).slice(0, 4);
    if (company.website && company.canonical_country && founders.length) {
      ready.push(toReadyRow(company, enrichment, founders));
    } else {
      needsReview.push({
        ...toCompanyRow(company),
        founder_candidates: enrichment.activeFounders.map((founder) => founder.name).join(" | "),
        review_reasons: [
          ...(!company.website ? ["Missing usable company website"] : []),
          ...(!founders.length ? ["No evidence-backed active founder with a full name"] : []),
          ...enrichment.warnings,
          ...enrichment.failures.map((failure) => failure.reason),
        ].join(" | "),
        founder_evidence: enrichment.founders.map((founder) =>
          `${founder.name} — ${founder.role} — ${founder.sourceUrl}`,
        ).join(" | "),
      });
    }
  }
  const unresolved = filtered.companies
    .filter((company) => company.location_classification === "unresolved_location" || company.location_classification === "conflicting_location")
    .map((company) => ({ ...toCompanyRow(company), review_reasons: "Company location is unresolved or conflicting; founder enrichment was not attempted." }));
  const excluded = [
    ...filtered.companies.filter((company) => company.location_classification === "outside_target_region").map((company) => ({
      record_type: "company", review_company_name: company.company_name,
      review_website: company.website ?? "", accelerator_year: primaryParticipation(company.participation).year,
      reason: "Confirmed outside Europe and North America", listed_location: company.listed_location ?? "",
      location_classification: company.location_classification, source_url: company.source_url,
    })),
    ...filtered.duplicate_audit.map((duplicate) => ({
      record_type: "duplicate", review_company_name: duplicate.company_name,
      review_website: duplicate.website, accelerator_year: duplicate.accelerator_year,
      reason: duplicate.reason, source_url: duplicate.source_url,
    })),
  ];
  const outputPath = path.resolve(process.cwd(), "exports", "Antler_2025_2026_Europe_North_America.xlsx");
  const compatibility = await writeAntlerFinalWorkbook({
    outputPath, ready, needsReview, unresolved,
    excluded,
    blocked: [...filtered.blocked_sources, ...filtered.rejected_sources],
  });
  console.log(`Stage 3 complete: ${ready.length} Ready rows, ${needsReview.length} founder-review rows, ${unresolved.length} unresolved-location rows.`);
  console.log(`Shared parser accepted ${compatibility.parsedFounders} founders.`);
  console.log(`Output: ${outputPath}`);
  return compatibility;
}

async function processSourceQueue(
  initial: readonly AntlerSourceCandidate[],
  options: CliOptions,
  cache: Awaited<ReturnType<typeof openAntlerCache>>,
  transport: SafeFetchTransportOptions,
) {
  const queue = [...initial];
  const seen = new Set(queue.map((candidate) => candidate.url));
  const results: AntlerSourceResult[] = [];
  for (let index = 0; index < queue.length && index < MAX_SOURCE_CANDIDATES; index += 1) {
    const candidate = queue[index];
    const key = candidate.url;
    const cached = cache.get<AntlerSourceResult>("sources", key);
    let result = cached?.status === "completed" ? cached.value : null;
    if (!result) {
      cache.markProcessing("sources", key);
      await cache.save();
      result = await processSource(candidate, options, transport);
      cache.set("sources", key, result.status === "retry_wait" ? "retry_wait" : "completed", result, result.error);
      await cache.save();
    }
    results.push(result);
    for (const linked of result.linked_candidates) {
      if (!seen.has(linked.url) && queue.length < MAX_SOURCE_CANDIDATES) {
        seen.add(linked.url);
        queue.push(linked);
      }
    }
  }
  return results;
}

async function processSource(
  candidate: AntlerSourceCandidate,
  options: CliOptions,
  transport: SafeFetchTransportOptions,
): Promise<AntlerSourceResult> {
  if (isRobotsDisallowedAntlerPath(candidate.url)) {
    return failedSource(candidate, "robots_blocked", "robots.txt disallows automated access; retained for manual review.");
  }
  try {
    const response = await fetchOfficialDiscoveryHtml(candidate.url, {}, transport);
    return validateAndExtractAntlerSource({
      html: response.html, finalUrl: response.finalUrl, candidate,
      targetYears: options.years, fetchedAt: response.fetchedAt,
      contentHash: response.contentHash,
    });
  } catch (error) {
    if (error instanceof DiscoveryFetchError) {
      return failedSource(candidate,
        error.kind === "blocked" ? "robots_blocked" : error.kind === "retry" ? "retry_wait" : "failed",
        error.message,
      );
    }
    return failedSource(candidate, "failed", error instanceof Error ? error.message : "Source request failed.");
  }
}

async function locationEnrichment(
  company: DiscoveredAntlerDocument["companies"][number],
  transport: SafeFetchTransportOptions,
) {
  const listed = company.listed_location && company.listed_location_evidence === "company_specific"
    ? resolveCountry(company.listed_location) : null;
  if (listed) return listingOnlyEnrichment(company, listed);
  return enrichStandaloneCompany({
    companyName: company.company_name, website: company.website,
    listedCountry: company.listed_location,
    listedCountryEvidence: company.listed_location_evidence,
    officialSourceUrl: company.source_url,
    officialRosterAuthority: "antler_official", includeFounders: false,
  }, { fetchHtml: companyFetcher(transport), maxPages: 5 });
}

async function founderEnrichment(
  company: FilteredAntlerCompany,
  transport: SafeFetchTransportOptions,
) {
  return enrichStandaloneCompany({
    companyName: company.company_name, website: company.website,
    listedCountry: company.canonical_country ?? company.listed_location,
    listedCountryEvidence: "company_specific", officialSourceUrl: company.source_url,
    officialRosterAuthority: "antler_official", includeFounders: true,
    sourceFounders: company.founders.map((founder) => ({
      name: founder.founder_name, role: founder.founder_role,
      linkedinUrl: founder.linkedin_url, sourceUrl: founder.source_url,
    })),
  }, { fetchHtml: companyFetcher(transport), maxPages: 5 });
}

function companyFetcher(transport: SafeFetchTransportOptions) {
  return async (url: string, context: { companyUrl: string }) => {
    const response = await fetchCompanyEnrichmentHtml(url, context.companyUrl, {}, transport);
    return { finalUrl: response.finalUrl, html: response.html,
      contentHash: response.contentHash, fetchedAt: response.fetchedAt };
  };
}

function listingOnlyEnrichment(
  company: DiscoveredAntlerDocument["companies"][number],
  country: NonNullable<ReturnType<typeof resolveCountry>>,
): CompanyEnrichmentResult {
  return {
    companyName: company.company_name, website: company.website,
    canonicalWebsite: company.website, pagesAttempted: [], pages: [], failures: [],
    locationStatus: "confirmed", headquartersCountry: country.canonicalName,
    headquartersIso2: country.iso2, headquartersRegion: country.region,
    locationEvidence: [{ country, sourceUrl: company.source_url,
      snippet: `Antler portfolio listing: ${company.listed_location}`,
      confidence: 0.95, authority: "antler_official", evidenceType: "participant_listing" }],
    founders: [], activeFounders: [], warnings: [],
  };
}

function failedCompanyEnrichment(
  companyName: string,
  website: string | null,
  error: unknown,
): CompanyEnrichmentResult {
  const reason = sanitizeError(error instanceof Error ? error.message : "Company enrichment failed.");
  return {
    companyName, website, canonicalWebsite: website, pagesAttempted: [], pages: [],
    failures: [{ url: website ?? "", reason, retryable: false, retryAt: null }],
    locationStatus: "missing", headquartersCountry: null, headquartersIso2: null,
    headquartersRegion: null, locationEvidence: [], founders: [], activeFounders: [],
    warnings: ["Company enrichment failed; the record was retained for manual review."],
  };
}

function toReadyRow(
  company: FilteredAntlerCompany,
  enrichment: CompanyEnrichmentResult,
  founders: CompanyEnrichmentResult["activeFounders"],
): AntlerReadyRow {
  const primary = primaryParticipation(company.participation);
  const values = founders.map((founder) => ({ name: founder.name, linkedin: founder.linkedinUrl ?? "" }));
  return {
    company_name: company.company_name, website: enrichment.canonicalWebsite ?? company.website ?? "",
    accelerator_batch: primary.program ?? "Antler", accelerator_year: primary.year,
    country: company.canonical_country ?? "", industry: company.industry ?? "",
    description: company.description ?? "", founder_name: values[0]?.name ?? "",
    founder_role: founders[0]?.role ?? "Founder", linkedin_url: values[0]?.linkedin ?? "",
    founder_2: values[1]?.name ?? "", linkedin_url_2: values[1]?.linkedin ?? "",
    founder_3: values[2]?.name ?? "", linkedin_url_3: values[2]?.linkedin ?? "",
    founder_4: values[3]?.name ?? "", linkedin_url_4: values[3]?.linkedin ?? "",
    source_url: primary.source_url,
  };
}

function createTransport(options: CliOptions): SafeFetchTransportOptions {
  const antlerLimiter = createAntlerHostLimiter({ minimumSpacingMs: options.hostSpacingMs });
  const companyLimiter = new SameHostRateLimiter({ minimumSpacingMs: 2_000 });
  return {
    beforeRequest: (url) => {
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      return (host === "antler.co" || host.endsWith(".antler.co")
        ? antlerLimiter : companyLimiter).wait(url).then(() => undefined);
    },
    userAgent: USER_AGENT,
    robotsCache: new Map(),
    onRetryAfter: (url, retryAt) => {
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      (host === "antler.co" || host.endsWith(".antler.co")
        ? antlerLimiter : companyLimiter).deferUntil(url, retryAt);
    },
  };
}

export function createAntlerHostLimiter(input: {
  minimumSpacingMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  return new SameHostRateLimiter({
    minimumSpacingMs: Math.max(
      ANTLER_MINIMUM_HOST_SPACING_MS,
      input.minimumSpacingMs ?? ANTLER_MINIMUM_HOST_SPACING_MS,
    ),
    now: input.now,
    sleep: input.sleep,
  });
}

function openStageCache(stage: "discover" | "filter" | "enrich", options: CliOptions) {
  return openAntlerCache({
    directory: path.resolve(CACHE_DIRECTORY, stage),
    fingerprint: antlerOptionsFingerprint({ version: 1, stage,
      years: options.years, regions: stage === "discover" ? [] : options.regions }),
    fresh: options.fresh,
  });
}

function failedSource(candidate: AntlerSourceCandidate, status: "robots_blocked" | "retry_wait" | "failed", error: string): AntlerSourceResult {
  return { candidate, status, final_url: null, page_title: null, fetched_at: null,
    content_hash: null, companies: [], linked_candidates: [], rejection_reasons: [],
    warnings: [], error: sanitizeError(error) };
}

function toBlockedSource(result: AntlerSourceResult): BlockedAntlerSource {
  return { source_url: result.candidate.url, source_title: result.page_title ?? result.candidate.programHint ?? "Antler source",
    accelerator_year: result.candidate.yearHint ?? "", source_kind: result.candidate.sourceKind,
    reason: result.error ?? (result.rejection_reasons.join(" | ") || "Source did not pass validation."),
    discovery_origin: result.candidate.origin, discovered_from: result.candidate.discoveredFrom ?? "",
    manual_review_status: "Manual review required" };
}

function companyKey(name: string, domain: string | null) {
  return createHash("sha256").update(domain ? `domain:${domain}` : `name:${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`).digest("hex");
}

function isEligible(company: FilteredAntlerCompany) {
  return company.location_classification === "europe" || company.location_classification === "north_america";
}

function assertYears(actual: readonly AntlerYear[], requested: readonly AntlerYear[]) {
  if (actual.join(",") !== requested.join(",")) throw new Error("The previous Antler stage was generated for different years. Rerun with matching options or --fresh.");
}

function sanitizeError(value: string) {
  return value.replace(/(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, "credential=[redacted]").slice(0, 500);
}

export function parseArguments(values: readonly string[]): CliOptions | null {
  if (values.includes("--help") || values.includes("-h")) { printHelp(); return null; }
  const options: CliOptions = { stage: "all", years: [2025, 2026],
    regions: ["europe", "north_america"], resume: false, fresh: false,
    hostSpacingMs: ANTLER_MINIMUM_HOST_SPACING_MS };
  for (const value of values) {
    if (value.startsWith("--stage=")) {
      const stage = value.slice(8);
      if (!["discover", "filter", "enrich", "all"].includes(stage)) throw new Error("--stage must be discover, filter, enrich, or all.");
      options.stage = stage as CliOptions["stage"];
    } else if (value === "--resume") options.resume = true;
    else if (value === "--fresh") options.fresh = true;
    else if (value.startsWith("--years=")) options.years = parseList(value.slice(8), [2025, 2026], "years") as AntlerYear[];
    else if (value.startsWith("--regions=")) options.regions = parseList(value.slice(10), ["europe", "north_america"], "regions") as AntlerRegion[];
    else if (value.startsWith("--host-spacing-ms=")) {
      const number = Number(value.slice(18));
      if (!Number.isFinite(number) || number < ANTLER_MINIMUM_HOST_SPACING_MS) throw new Error("Antler --host-spacing-ms cannot be lower than 10000.");
      options.hostSpacingMs = Math.ceil(number);
    } else throw new Error(`Unknown option: ${value}`);
  }
  if (options.resume && options.fresh) throw new Error("Use either --resume or --fresh, not both.");
  return options;
}

function parseList<T extends string | number>(raw: string, allowed: readonly T[], label: string) {
  const values = raw.split(",").map((entry) => typeof allowed[0] === "number" ? Number(entry) : entry) as T[];
  if (!values.length || values.some((value) => !allowed.includes(value))) throw new Error(`Invalid --${label} value.`);
  return [...new Set(values)];
}

function printHelp() {
  console.log("Usage: npm run lead:antler[:discover|:filter|:enrich] -- [--years=2025,2026] [--regions=europe,north_america] [--resume|--fresh] [--host-spacing-ms=10000]");
}

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
