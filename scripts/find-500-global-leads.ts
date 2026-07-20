import { createHash } from "node:crypto";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import {
  enrichStandaloneCompany,
  type CompanyEnrichmentResult,
} from "@/lib/500-global/company-enrichment";
import {
  createOptionsFingerprint,
  openExporterCache,
  type ExporterCache,
} from "@/lib/500-global/exporter-cache";
import {
  classifyFinalCompanies,
  mergeValidatedSourceExtractions,
  type DuplicateCompanyAudit,
} from "@/lib/500-global/exporter-pipeline";
import type {
  ExporterCompanyRecord,
  ExporterFinalCompany,
} from "@/lib/500-global/exporter-pipeline-types";
import type {
  ExporterRegion,
  ExporterYear,
  SourceCandidate,
  ValidatedSourceExtraction,
} from "@/lib/500-global/exporter-types";
import {
  DiscoveryFetchError,
  fetchCompanyEnrichmentHtml,
  fetchOfficialDiscoveryHtml,
  type SafeFetchTransportOptions,
} from "@/lib/500-global/safe-fetch";
import {
  createBraveSourceSearchProvider,
  discoverOfficialSourceCandidates,
  extractLinkedOfficialSourceCandidates,
  APPROVED_EXPORTER_PARTNER_HOSTS,
  MAINTAINED_EXPORTER_SOURCES,
} from "@/lib/500-global/source-discovery";
import { validateAndExtractParticipantSource } from "@/lib/500-global/source-validation";
import {
  deserializeSourceWorkResult,
  serializeSourceWorkResultForCache,
  type SafeCachedSourceWorkResult,
  type SourceWorkResult,
} from "@/lib/500-global/source-cache-serialization";
import { mapWithConcurrency, SameHostRateLimiter } from "@/lib/500-global/rate-limiter";
import {
  validate500GlobalWorkbook,
  write500GlobalWorkbook,
  type ExcludedExportRow,
  type BlockedSourceExportRow,
  type NeedsReviewExportRow,
} from "@/lib/500-global/xlsx-export";
import { resolveCountry } from "@/lib/geography";

const COVERAGE_STATEMENT =
  "All matching companies found from verified official sources currently discovered and supported by the exporter.";
const CACHE_DIRECTORY = path.resolve(process.cwd(), ".cache", "500-global");
const MAX_SOURCE_CANDIDATES = 100;
const USER_AGENT =
  "FounderEmailVerifier/1.0 standalone-500-global-lead-exporter";

export type CliOptions = {
  years: ExporterYear[];
  regions: ExporterRegion[];
  resume: boolean;
  fresh: boolean;
  sourceConcurrency: 1 | 2;
  companyConcurrency: 1 | 2 | 3;
  hostSpacingMs: number;
};

type CompanyWorkResult = {
  company: ExporterCompanyRecord;
  enrichment: CompanyEnrichmentResult;
  enrichmentSkipped: boolean;
};

async function main() {
  loadEnvConfig(process.cwd());
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;

  const outputPath = path.resolve(
    process.cwd(),
    "exports",
    outputFilename(options),
  );
  const fingerprint = createOptionsFingerprint({
    schemaVersion: 1,
    years: options.years,
    regions: options.regions,
    catalog: MAINTAINED_EXPORTER_SOURCES,
    approvedPartnerHosts: APPROVED_EXPORTER_PARTNER_HOSTS,
  });
  const cache = await openExporterCache({
    directory: CACHE_DIRECTORY,
    optionsFingerprint: fingerprint,
    fresh: options.fresh,
  });
  const limiter = new SameHostRateLimiter({
    minimumSpacingMs: options.hostSpacingMs,
  });
  const transport: SafeFetchTransportOptions = {
    beforeRequest: (url) => limiter.wait(url).then(() => undefined),
    userAgent: USER_AGENT,
    robotsCache: new Map(),
    onRetryAfter: (url, retryAt) => {
      limiter.deferUntil(url, retryAt);
    },
  };

  console.log(
    `500 Global exporter: years=${options.years.join(",")} regions=${options.regions.join(",")} ${options.resume ? "resume" : options.fresh ? "fresh" : "standard"}`,
  );
  console.log("Discovering official participant-source candidates...");

  const discovery = await discoverOfficialSourceCandidates({
    years: options.years,
    fetchIndex: async (url) => {
      const response = await fetchOfficialDiscoveryHtml(url, {}, transport);
      return { html: response.html, finalUrl: response.finalUrl };
    },
    searchProvider: createBraveSourceSearchProvider(),
  });
  const sourceResults = await processSourceQueue(
    discovery.candidates,
    options,
    cache,
    transport,
  );

  const extractions = sourceResults
    .map((result) => result.extraction)
    .filter((value): value is ValidatedSourceExtraction => value !== null);
  const extractedCompanyCount = extractions.reduce(
    (total, extraction) => total + extraction.participants.length,
    0,
  );
  const merged = mergeValidatedSourceExtractions(extractions);
  console.log(
    `Validated sources: ${extractions.length}; extracted companies: ${extractedCompanyCount}; unique before enrichment: ${merged.companies.length}.`,
  );

  let completedCompanies = 0;
  const enriched = await mapWithConcurrency(
    merged.companies,
    async (company) => {
      const result = await processCompany(
        company,
        options,
        cache,
        transport,
      );
      completedCompanies += 1;
      console.log(
        `Company enrichment ${completedCompanies}/${merged.companies.length}: ${company.companyName}`,
      );
      return result;
    },
    options.companyConcurrency,
  );
  const finalCompanies = enriched.map(toFinalCompany);
  const classified = classifyFinalCompanies(
    finalCompanies,
    options.years,
    options.regions,
  );

  const coverageWarnings = buildCoverageWarnings({
    years: options.years,
    discoveryWarnings: discovery.warnings,
    sourceResults,
    finalCompanies,
    readyCount: classified.ready.length,
  });
  cache.setCoverageWarnings(coverageWarnings);
  await cache.save();

  const needsReview = [
    ...classified.needsReview.map(toNeedsReviewRow),
    ...sourceResults
      .filter((result) =>
        ["failed", "retry_wait", "robots_blocked", "cache_error"].includes(
          result.status,
        ),
      )
      .map(toSourceWarningRow),
  ];
  const excluded = [
    ...classified.excluded.map((company) => toExcludedCompanyRow(company)),
    ...merged.duplicates.map(toDuplicateRow),
    ...sourceResults
      .filter((result) => result.status === "rejected")
      .map(toRejectedSourceRow),
  ];
  const blockedSources = sourceResults
    .filter((result) => result.status === "robots_blocked")
    .map(toBlockedSourceRow);
  const compatibility = await write500GlobalWorkbook({
    outputPath,
    ready: classified.ready,
    needsReview,
    excluded,
    blockedSources,
    coverageWarnings,
  });
  // Keep this explicit second check close to the terminal handoff so a later
  // writer change cannot accidentally bypass upload compatibility validation.
  await validate500GlobalWorkbook(outputPath, classified.ready);

  printSummary({
    discovered: sourceResults.length,
    validated: extractions.length,
    processed: sourceResults.filter((result) => result.fetch !== null).length,
    rejected: sourceResults.filter((result) => result.status === "rejected").length,
    extracted: extractedCompanyCount,
    unique: merged.companies.length,
    targetRegion: finalCompanies.filter(
      (company) =>
        company.locationStatus === "confirmed" &&
        company.headquartersRegion !== null &&
        options.regions.includes(company.headquartersRegion),
    ).length,
    ready: classified.ready.length,
    needsReview: needsReview.length,
    excludedGeography: finalCompanies.filter(
      (company) =>
        company.locationStatus === "confirmed" &&
        (!company.headquartersRegion ||
          !options.regions.includes(company.headquartersRegion)),
    ).length,
    missingFounders: finalCompanies.filter(
      (company) =>
        !company.founders.some((founder) => founder.activeStatus === "confirmed"),
    ).length,
    outputPath,
    parsedFounders: compatibility.parsedFounders,
    coverageWarnings,
  });
}

type SourceProcessingDependencies = {
  fetchSource: typeof fetchOfficialDiscoveryHtml;
  validateSource: typeof validateAndExtractParticipantSource;
  extractLinkedCandidates: typeof extractLinkedOfficialSourceCandidates;
  serializeResult: typeof serializeSourceWorkResultForCache;
};

const DEFAULT_SOURCE_DEPENDENCIES: SourceProcessingDependencies = {
  fetchSource: fetchOfficialDiscoveryHtml,
  validateSource: validateAndExtractParticipantSource,
  extractLinkedCandidates: extractLinkedOfficialSourceCandidates,
  serializeResult: serializeSourceWorkResultForCache,
};

export async function processSourceQueue(
  initialCandidates: readonly SourceCandidate[],
  options: CliOptions,
  cache: ExporterCache,
  transport: SafeFetchTransportOptions,
  dependencies: Partial<SourceProcessingDependencies> = {},
) {
  const sourceDependencies = { ...DEFAULT_SOURCE_DEPENDENCIES, ...dependencies };
  const queue: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of initialCandidates) {
    enqueueSource(queue, seen, candidate);
  }
  if (options.resume) {
    for (const item of Object.values(cache.snapshot().sources)) {
      const value = deserializeSourceWorkResult(item.value);
      if (value?.candidate?.url) enqueueSource(queue, seen, value.candidate);
    }
  }

  const results: SourceWorkResult[] = [];
  let cursor = 0;
  while (cursor < queue.length && cursor < MAX_SOURCE_CANDIDATES) {
    const batch = queue.slice(
      cursor,
      Math.min(cursor + options.sourceConcurrency, MAX_SOURCE_CANDIDATES),
    );
    cursor += batch.length;
    const batchResults = await mapWithConcurrency(
      batch,
      (candidate) =>
        processSource(candidate, options, cache, transport, sourceDependencies),
      options.sourceConcurrency,
    );
    results.push(...batchResults);
    for (const result of batchResults) {
      for (const linked of result.linkedCandidates) {
        if (queue.length >= MAX_SOURCE_CANDIDATES) break;
        enqueueSource(queue, seen, linked);
      }
    }
    console.log(
      `Official sources handled: ${results.length}/${queue.length}${queue.length >= MAX_SOURCE_CANDIDATES ? " (candidate cap reached)" : ""}.`,
    );
  }
  return results;
}

async function processSource(
  candidate: SourceCandidate,
  options: CliOptions,
  cache: ExporterCache,
  transport: SafeFetchTransportOptions,
  dependencies: SourceProcessingDependencies,
): Promise<SourceWorkResult> {
  const key = sourceKey(candidate.url);
  const cached = cache.get<SafeCachedSourceWorkResult>("sources", key);
  const cachedResult = deserializeSourceWorkResult(cached?.value);
  if (options.resume && cached?.status === "completed" && cached.value) {
    return cachedResult ?? cacheErrorResult(candidate, "Cached source result was invalid and was ignored.");
  }
  if (
    cached?.status === "retry_wait" &&
    cached.retryAt &&
    Date.parse(cached.retryAt) > Date.now() &&
    cachedResult
  ) {
    return cachedResult;
  }

  try {
    cache.markProcessing("sources", key);
    await cache.save();
  } catch (error) {
    return persistSourceResult(
      cache,
      key,
      cacheErrorResult(candidate, `cache_error: ${sanitizeError(error)}`),
      { kind: "failed" },
      dependencies.serializeResult,
    );
  }
  try {
    const fetched = await dependencies.fetchSource(candidate.url, {}, transport);
    const resolvedCandidate: SourceCandidate = {
      ...candidate,
      originalUrl: candidate.originalUrl ?? candidate.url,
      url: fetched.finalUrl,
    };
    const { validation, extraction } = dependencies.validateSource(
      fetched.html,
      resolvedCandidate,
      {
        targetYears: options.years,
        approvedPartnerHosts: APPROVED_EXPORTER_PARTNER_HOSTS,
      },
    );
    const result: SourceWorkResult = {
      candidate: resolvedCandidate,
      status: validation.accepted ? "validated" : "rejected",
      fetch: {
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        contentHash: fetched.contentHash,
        fetchedAt: fetched.fetchedAt,
        redirectCount: fetched.redirectCount,
      },
      validation,
      extraction,
      linkedCandidates: validation.accepted
        ? dependencies.extractLinkedCandidates(
            fetched.html,
            fetched.finalUrl,
            options.years,
          )
        : [],
      error: null,
    };
    return persistSourceResult(
      cache,
      key,
      result,
      { kind: "completed" },
      dependencies.serializeResult,
    );
  } catch (error) {
    const retry = error instanceof DiscoveryFetchError && error.kind === "retry";
    const terminalRejection =
      error instanceof DiscoveryFetchError && error.kind === "invalid";
    const robotsBlocked =
      error instanceof DiscoveryFetchError && error.kind === "blocked";
    const result: SourceWorkResult = {
      candidate,
      status: retry
        ? "retry_wait"
        : terminalRejection
          ? "rejected"
          : robotsBlocked
            ? "robots_blocked"
            : "failed",
      fetch: null,
      validation: null,
      extraction: null,
      linkedCandidates: [],
      error: sanitizeError(error),
    };
    const cacheStatus = retry && error.retryAt
      ? { kind: "retry" as const, retryAt: error.retryAt }
      : terminalRejection || robotsBlocked
        ? { kind: "completed" as const }
        : { kind: "failed" as const };
    return persistSourceResult(
      cache,
      key,
      result,
      cacheStatus,
      dependencies.serializeResult,
    );
  }
}

type SourceCacheDisposition =
  | { kind: "completed" }
  | { kind: "failed" }
  | { kind: "retry"; retryAt: string };

async function persistSourceResult(
  cache: ExporterCache,
  key: string,
  result: SourceWorkResult,
  disposition: SourceCacheDisposition,
  serializeResult: typeof serializeSourceWorkResultForCache,
): Promise<SourceWorkResult> {
  try {
    const serialized = serializeResult(result);
    if (!serialized) throw new Error("Source result could not be serialized safely.");
    if (disposition.kind === "completed") {
      cache.markCompleted("sources", key, serialized);
    } else if (disposition.kind === "failed") {
      cache.markFailed(
        "sources",
        key,
        serialized,
        result.error ?? "Source processing failed.",
      );
    } else {
      cache.markRetry(
        "sources",
        key,
        serialized,
        disposition.retryAt,
        result.error ?? "Source fetch was rate-limited.",
      );
    }
    await cache.save();
    return result;
  } catch (error) {
    const fallback = cacheErrorResult(
      result.candidate,
      `cache_error: ${sanitizeError(error)}`,
    );
    try {
      const serializedFallback = serializeSourceWorkResultForCache(fallback);
      if (serializedFallback) {
        cache.markFailed("sources", key, serializedFallback, fallback.error ?? "Cache error");
        await cache.save();
      }
    } catch {
      // The warning remains in the returned result even when the cache itself
      // is temporarily unwritable. The next source must still be processed.
    }
    return fallback;
  }
}

function cacheErrorResult(candidate: SourceCandidate, error: string): SourceWorkResult {
  return {
    candidate,
    status: "cache_error",
    fetch: null,
    validation: null,
    extraction: null,
    linkedCandidates: [],
    error,
  };
}

async function processCompany(
  company: ExporterCompanyRecord,
  options: CliOptions,
  cache: ExporterCache,
  transport: SafeFetchTransportOptions,
): Promise<CompanyWorkResult> {
  const listedCountry = company.listedCountry
    ? resolveCountry(company.listedCountry)
    : null;
  if (
    company.listedCountryEvidence === "company_specific" &&
    listedCountry &&
    (!listedCountry.region || !options.regions.includes(listedCountry.region))
  ) {
    return {
      company,
      enrichment: locationOnlyEnrichment(company, listedCountry),
      enrichmentSkipped: true,
    };
  }

  const key = companyKey(company);
  const cached = cache.get<CompanyEnrichmentResult>("companies", key);
  if (options.resume && cached?.status === "completed" && cached.value) {
    return { company, enrichment: cached.value, enrichmentSkipped: false };
  }
  if (
    cached?.status === "retry_wait" &&
    cached.retryAt &&
    Date.parse(cached.retryAt) > Date.now() &&
    cached.value
  ) {
    return { company, enrichment: cached.value, enrichmentSkipped: false };
  }

  cache.markProcessing("companies", key);
  await cache.save();
  try {
    const enrichment = await enrichStandaloneCompany(
      {
        companyName: company.companyName,
        website: company.website,
        listedCountry:
          company.listedCountryEvidence === "company_specific"
            ? company.listedCountry
            : null,
        listedCountryEvidence: company.listedCountryEvidence,
        officialSourceUrl: company.sourceUrl,
        sourceFounders: company.founders.map((founder) => ({
          name: founder.founderName,
          role: founder.founderRole,
          linkedinUrl: founder.linkedinUrl,
          sourceUrl: founder.sourceUrl,
        })),
      },
      {
        fetchHtml: async (url, context) => {
          const fetched = await fetchCompanyEnrichmentHtml(
            url,
            context.companyUrl,
            {},
            transport,
          );
          return {
            finalUrl: fetched.finalUrl,
            html: fetched.html,
            contentHash: fetched.contentHash,
            fetchedAt: fetched.fetchedAt,
          };
        },
      },
    );
    const retryAt = enrichment.failures
      .map((failure) => failure.retryAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
    const hasRetryableFailure = enrichment.failures.some(
      (failure) => failure.retryable,
    );
    if (retryAt) {
      cache.markRetry(
        "companies",
        key,
        enrichment,
        retryAt,
        "Company enrichment was rate-limited.",
      );
    } else if (hasRetryableFailure) {
      cache.markFailed(
        "companies",
        key,
        enrichment,
        "Company enrichment encountered a transient fetch failure.",
      );
    } else {
      cache.markCompleted("companies", key, enrichment);
    }
    await cache.save();
    return { company, enrichment, enrichmentSkipped: false };
  } catch (error) {
    const enrichment = failedEnrichment(company, sanitizeError(error));
    cache.markFailed(
      "companies",
      key,
      enrichment,
      sanitizeError(error),
    );
    await cache.save();
    return { company, enrichment, enrichmentSkipped: false };
  }
}

function toFinalCompany(result: CompanyWorkResult): ExporterFinalCompany {
  const { company, enrichment } = result;
  const reviewReasons: string[] = [];
  if (
    !result.enrichmentSkipped &&
    company.website &&
    enrichment.pages.length === 0
  ) {
    reviewReasons.push(
      "The company website could not be fetched, so its usability and enrichment evidence require review.",
    );
  }
  if (
    company.warnings.some((warning) =>
      /conflicting company-location values/i.test(warning),
    )
  ) {
    reviewReasons.push(
      "Official participant sources contain conflicting company-location values.",
    );
  }
  const locationStatus: ExporterFinalCompany["locationStatus"] =
    enrichment.locationStatus === "provisional"
      ? enrichment.headquartersCountry
        ? "confirmed"
        : "missing"
      : enrichment.locationStatus;
  return {
    ...company,
    website: enrichment.canonicalWebsite ?? company.website,
    founders: enrichment.founders.map((founder) => ({
      founderName: founder.name,
      founderRole: founder.role,
      linkedinUrl: founder.linkedinUrl,
      sourceUrl: founder.sourceUrl,
      confidence: founder.confidence,
      activeStatus: founder.activeStatus,
    })),
    headquartersCountry: enrichment.headquartersCountry,
    headquartersIso2: enrichment.headquartersIso2,
    headquartersRegion: enrichment.headquartersRegion,
    locationStatus,
    locationEvidence: enrichment.locationEvidence.map(
      (evidence) =>
        `${evidence.country.canonicalName} (${evidence.authority}, ${evidence.evidenceType}) — ${evidence.snippet}`,
    ),
    founderEvidence: enrichment.founders.map(
      (founder) =>
        `${founder.name} — ${founder.role} (${founder.activeStatus}; ${founder.sourceUrl})`,
    ),
    reviewReasons,
    warnings: [...new Set([...company.warnings, ...enrichment.warnings])],
  };
}

function locationOnlyEnrichment(
  company: ExporterCompanyRecord,
  country: NonNullable<ReturnType<typeof resolveCountry>>,
): CompanyEnrichmentResult {
  return {
    companyName: company.companyName,
    website: company.website,
    canonicalWebsite: company.website,
    pagesAttempted: [],
    pages: [],
    failures: [],
    locationStatus: "confirmed",
    headquartersCountry: country.canonicalName,
    headquartersIso2: country.iso2,
    headquartersRegion: country.region,
    locationEvidence: [
      {
        country,
        sourceUrl: company.sourceUrl,
        snippet: `The verified official participant entry lists ${country.canonicalName} as the company location.`,
        confidence: 0.72,
        authority: "500_global_official",
        evidenceType: "participant_listing",
      },
    ],
    founders: company.founders.map((founder) => ({
      name: founder.founderName,
      role: founder.founderRole ?? "Founder role not confirmed",
      linkedinUrl: founder.linkedinUrl,
      activeStatus:
        founder.activeStatus === "former"
          ? "former"
          : founder.activeStatus === "confirmed"
            ? "confirmed"
            : "possible",
      confidence: founder.confidence,
      sourceUrl: founder.sourceUrl,
      snippet: `${founder.founderName} — ${founder.founderRole ?? "role unavailable"}`,
    })),
    activeFounders: [],
    warnings: [
      "Company-site founder enrichment was skipped because the verified company location is outside the requested regions.",
    ],
  };
}

function failedEnrichment(
  company: ExporterCompanyRecord,
  reason: string,
): CompanyEnrichmentResult {
  return {
    companyName: company.companyName,
    website: company.website,
    canonicalWebsite: company.website,
    pagesAttempted: [],
    pages: [],
    failures: company.website
      ? [{ url: company.website, reason, retryable: true, retryAt: null }]
      : [],
    locationStatus: "missing",
    headquartersCountry: null,
    headquartersIso2: null,
    headquartersRegion: null,
    locationEvidence: [],
    founders: [],
    activeFounders: [],
    warnings: ["Company enrichment failed and requires review."],
  };
}

function buildCoverageWarnings(input: {
  years: readonly ExporterYear[];
  discoveryWarnings: readonly string[];
  sourceResults: readonly SourceWorkResult[];
  finalCompanies: readonly ExporterFinalCompany[];
  readyCount: number;
}) {
  const warnings = [COVERAGE_STATEMENT, ...input.discoveryWarnings];
  for (const year of input.years) {
    const validatedForYear = input.sourceResults.filter(
      (result) =>
        result.status === "validated" &&
        result.extraction?.source.acceleratorYear === year,
    );
    if (!validatedForYear.length) {
      warnings.push(`No verified participant roster was processed for ${year}.`);
    }
    warnings.push(
      `${year} coverage is partial; maintained sources and supported discovery do not prove complete worldwide coverage.`,
    );
  }
  for (const result of input.sourceResults) {
    for (const warning of result.validation?.warnings ?? []) {
      warnings.push(`${result.candidate.url}: ${warning}`);
    }
    for (const warning of result.extraction?.warnings ?? []) {
      warnings.push(`${result.candidate.url}: ${warning}`);
    }
  }
  const failedSources = input.sourceResults.filter(
    (result) =>
      ["failed", "retry_wait", "robots_blocked", "cache_error"].includes(
        result.status,
      ),
  ).length;
  if (failedSources) {
    warnings.push(
      `${failedSources} official source candidate${failedSources === 1 ? "" : "s"} could not be processed in this run.`,
    );
  }
  const robotsBlockedSources = input.sourceResults.filter(
    (result) => result.status === "robots_blocked",
  ).length;
  if (robotsBlockedSources) {
    warnings.push(
      `${robotsBlockedSources} official source candidate${robotsBlockedSources === 1 ? " was" : "s were"} skipped because robots.txt disallows automated access.`,
    );
  }
  const siteFailures = input.finalCompanies.filter((company) =>
    company.warnings.some((warning) => /site could not be fetched/i.test(warning)),
  ).length;
  if (siteFailures) {
    warnings.push(
      `${siteFailures} company site${siteFailures === 1 ? "" : "s"} could not be fetched; enrichment is incomplete.`,
    );
  }
  const missingFounders = input.finalCompanies.filter(
    (company) =>
      !company.founders.some((founder) => founder.activeStatus === "confirmed"),
  ).length;
  if (missingFounders) {
    warnings.push(
      `Founder data is incomplete for ${missingFounders} compan${missingFounders === 1 ? "y" : "ies"}.`,
    );
  }
  if (input.readyCount === 0) {
    warnings.push(
      "No Ready for Upload rows were produced; do not import this workbook unless eligible rows are reviewed and added to the Ready sheet.",
    );
  }
  return [...new Set(warnings)].slice(0, 250);
}

function toNeedsReviewRow(company: ExporterFinalCompany): NeedsReviewExportRow {
  return {
    record_type: "company",
    review_company_name: company.companyName,
    review_website: company.website ?? "",
    accelerator_batch: company.acceleratorBatch ?? "",
    accelerator_year: company.acceleratorYear,
    country: company.headquartersCountry ?? company.listedCountry ?? "",
    industry: company.industry ?? "",
    description: company.description ?? "",
    founder_candidates: company.founders
      .map((founder) =>
        `${founder.founderName} — ${founder.founderRole ?? "role unavailable"} (${founder.activeStatus})`,
      )
      .join(" | "),
    review_reasons: company.reviewReasons.join(" | "),
    location_evidence: company.locationEvidence.join(" | "),
    founder_evidence: company.founderEvidence.join(" | "),
    additional_source_urls: company.supportingSourceUrls
      .filter((url) => url !== company.sourceUrl)
      .join(" | "),
    source_kind: company.sourceKind,
    extraction_strategy: company.extractionStrategies.join(" | "),
    source_url: company.sourceUrl,
  };
}

function toSourceWarningRow(result: SourceWorkResult): NeedsReviewExportRow {
  return {
    record_type: "source_warning",
    review_company_name:
      result.candidate.acceleratorBatchHint ?? "Unprocessed official source candidate",
    accelerator_year: result.candidate.acceleratorYearHint ?? "",
    review_reasons:
      result.error ?? "The source remains pending because it was rate-limited.",
    source_kind: result.candidate.sourceKindHint ?? "",
    extraction_strategy: result.candidate.strategyHints?.join(" | ") ?? "",
    source_url: result.candidate.url,
  };
}

function toExcludedCompanyRow(
  company: ExporterFinalCompany & { exclusionReason: string },
): ExcludedExportRow {
  return {
    record_type: "company",
    excluded_company_name: company.companyName,
    excluded_website: company.website ?? "",
    accelerator_year: company.acceleratorYear,
    exclusion_reason: company.exclusionReason,
    listed_country: company.listedCountry ?? company.headquartersCountry ?? "",
    normalized_region: company.headquartersRegion ?? "outside_supported_regions",
    source_url: company.sourceUrl,
    source_kind: company.sourceKind,
    extraction_strategy: company.extractionStrategies.join(" | "),
  };
}

function toDuplicateRow(duplicate: DuplicateCompanyAudit): ExcludedExportRow {
  return {
    record_type: "duplicate",
    excluded_company_name: duplicate.companyName,
    excluded_website: duplicate.website ?? "",
    accelerator_year: duplicate.acceleratorYear ?? "",
    exclusion_reason: duplicate.reason,
    source_url: duplicate.sourceUrl,
    source_kind: duplicate.sourceKind,
    extraction_strategy: duplicate.extractionStrategy,
  };
}

function toRejectedSourceRow(result: SourceWorkResult): ExcludedExportRow {
  const reasons = result.validation?.reasonCodes.join(", ") || result.error;
  return {
    record_type: "source",
    excluded_company_name:
      result.candidate.acceleratorBatchHint ?? "Rejected source candidate",
    accelerator_year: result.candidate.acceleratorYearHint ?? "",
    exclusion_reason: reasons || "The candidate did not pass source validation.",
    source_url: result.candidate.url,
    source_kind: result.candidate.sourceKindHint ?? "",
    extraction_strategy: result.candidate.strategyHints?.join(" | ") ?? "",
  };
}

function toBlockedSourceRow(result: SourceWorkResult): BlockedSourceExportRow {
  return {
    source_url: result.candidate.url,
    source_title:
      result.validation?.source?.pageTitle ??
      result.candidate.acceleratorBatchHint ??
      "Official source title unavailable because automated access is blocked",
    accelerator_year: result.candidate.acceleratorYearHint ?? "",
    source_kind: result.candidate.sourceKindHint ?? "",
    reason: result.error ?? "robots.txt disallows automated access.",
    discovery_origin: result.candidate.origin ?? "",
    discovered_from: result.candidate.discoveredFrom ?? "",
    manual_review_status: "Review manually or add an accessible official participant source",
  };
}

function printSummary(input: {
  discovered: number;
  validated: number;
  processed: number;
  rejected: number;
  extracted: number;
  unique: number;
  targetRegion: number;
  ready: number;
  needsReview: number;
  excludedGeography: number;
  missingFounders: number;
  outputPath: string;
  parsedFounders: number;
  coverageWarnings: readonly string[];
}) {
  console.log("\n500 Global lead export complete");
  console.log(`Official sources discovered: ${input.discovered}`);
  console.log(`Sources validated: ${input.validated}`);
  console.log(`Sources processed: ${input.processed}`);
  console.log(`Sources rejected: ${input.rejected}`);
  console.log(`Companies extracted: ${input.extracted}`);
  console.log(`Unique companies: ${input.unique}`);
  console.log(`Europe/North America companies: ${input.targetRegion}`);
  console.log(`Ready rows: ${input.ready}`);
  console.log(`Needs-review rows: ${input.needsReview}`);
  console.log(`Excluded geography: ${input.excludedGeography}`);
  console.log(`Missing founders: ${input.missingFounders}`);
  console.log(`Upload-parser founder records: ${input.parsedFounders}`);
  console.log(`Output path: ${input.outputPath}`);
  console.log("Coverage warnings:");
  for (const warning of input.coverageWarnings) console.log(`- ${warning}`);
}

function enqueueSource(
  queue: SourceCandidate[],
  seen: Set<string>,
  candidate: SourceCandidate,
) {
  try {
    const key = sourceKey(candidate.url);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(candidate);
  } catch {
    // Invalid candidates are discarded before any request is made.
  }
}

function sourceKey(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Source URL must use HTTPS.");
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function companyKey(company: ExporterCompanyRecord) {
  const identity = company.normalizedDomain
    ? `domain:${company.normalizedDomain}`
    : `name:${normalizeCompanyName(company.companyName)}`;
  return createHash("sha256").update(identity).digest("hex");
}

function normalizeCompanyName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function outputFilename(options: CliOptions) {
  const years = options.years.join("_");
  const regions = options.regions
    .map((region) =>
      region === "north_america" ? "North_America" : "Europe",
    )
    .join("_");
  return `500_Global_${years}_${regions}.xlsx`;
}

export function parseArguments(values: readonly string[]): CliOptions | null {
  if (values.includes("--help") || values.includes("-h")) {
    printHelp();
    return null;
  }
  const options: CliOptions = {
    years: [2025, 2026],
    regions: ["europe", "north_america"],
    resume: false,
    fresh: false,
    sourceConcurrency: 1,
    companyConcurrency: 2,
    hostSpacingMs: 2_000,
  };
  for (const value of values) {
    if (value === "--resume") {
      options.resume = true;
      continue;
    }
    if (value === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (value.startsWith("--years=")) {
      options.years = parseEnumList(
        value.slice("--years=".length),
        [2025, 2026],
        "years",
        (entry) => Number(entry) as ExporterYear,
      );
      continue;
    }
    if (value.startsWith("--regions=")) {
      options.regions = parseEnumList(
        value.slice("--regions=".length),
        ["europe", "north_america"],
        "regions",
        (entry) => entry as ExporterRegion,
      );
      continue;
    }
    if (value.startsWith("--source-concurrency=")) {
      const concurrency = parseIntegerOption(value, "source-concurrency", 1, 2);
      options.sourceConcurrency = concurrency as 1 | 2;
      continue;
    }
    if (value.startsWith("--company-concurrency=")) {
      const concurrency = parseIntegerOption(value, "company-concurrency", 1, 3);
      options.companyConcurrency = concurrency as 1 | 2 | 3;
      continue;
    }
    if (value.startsWith("--host-spacing-ms=")) {
      options.hostSpacingMs = parseIntegerOption(
        value,
        "host-spacing-ms",
        2_000,
        60_000,
      );
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (options.resume && options.fresh) {
    throw new Error("Use either --resume or --fresh, not both.");
  }
  return options;
}

function parseEnumList<T>(
  raw: string,
  allowed: readonly T[],
  label: string,
  convert: (value: string) => T,
) {
  const entries = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  const converted = entries.map(convert);
  if (
    !converted.length ||
    converted.some((value) => !allowed.includes(value))
  ) {
    throw new Error(`${label} must contain only: ${allowed.join(", ")}.`);
  }
  return converted;
}

function parseIntegerOption(
  argument: string,
  name: string,
  minimum: number,
  maximum: number,
) {
  const raw = argument.slice(`--${name}=`.length);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Operation failed.";
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .trim()
    .slice(0, 300);
}

function printHelp() {
  console.log(`Usage: npm run lead:500global -- [options]

Options:
  --years=2025,2026                 Accelerator years (default: 2025,2026)
  --regions=europe,north_america    Eligible regions (default: both)
  --resume                          Reuse completed local cache work
  --fresh                           Safely reset the exporter cache first
  --source-concurrency=1|2          Official-source concurrency (default: 1)
  --company-concurrency=1|2|3       Company enrichment concurrency (default: 2)
  --host-spacing-ms=2000..60000     Minimum same-host delay (default: 2000)
  --help                            Show this help

The command writes an XLSX workbook only. It does not write to Supabase, import
records, call Reoon, or fetch authenticated LinkedIn pages.`);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`500 Global exporter failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
