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
} from "@/lib/masschallenge/exporter-cache";
import {
  classifyFinalCompanies,
  mergeValidatedSourceExtractions,
  type DuplicateCompanyAudit,
} from "@/lib/masschallenge/exporter-pipeline";
import type {
  ExporterCompanyRecord,
  ExporterFinalCompany,
} from "@/lib/masschallenge/exporter-pipeline-types";
import {
  discoveredDatasetPath,
  filteredDatasetPath,
  readDiscoveredDocument,
  readFilteredDocument,
  MASSCHALLENGE_STAGE_SCHEMA_VERSION,
  writeStageDocument,
  type DiscoveredMassChallengeCompany,
  type DiscoveredMassChallengeDocument,
  type FilteredMassChallengeCompany,
  type FilteredMassChallengeDocument,
  type MassChallengeLocationClassification,
} from "@/lib/masschallenge/staged-workflow";
import { writeMassChallengeCompanyWorkbook } from "@/lib/masschallenge/stage-workbook";
import type {
  ExporterRegion,
  ExporterYear,
  SourceCandidate,
  ValidatedSourceExtraction,
} from "@/lib/masschallenge/exporter-types";
import {
  DiscoveryFetchError,
  fetchCompanyEnrichmentHtml,
  fetchOfficialDiscoveryHtml,
  type SafeFetchTransportOptions,
} from "@/lib/500-global/safe-fetch";

export const MASSCHALLENGE_STAGE_TWO_MAX_WEBSITE_CHECKS = 1;
export const MASSCHALLENGE_STAGE_TWO_COMPANY_TIMEOUT_MS = 20_000;
const STAGE_TWO_LIMIT_WARNING =
  "Stage 2 checks at most one company website for 20 seconds; unresolved results are preserved for review without automatic retries.";
import {
  createBraveSourceSearchProvider,
  discoverOfficialSourceCandidates,
  extractLinkedOfficialSourceCandidates,
  APPROVED_EXPORTER_PARTNER_HOSTS,
  MAINTAINED_EXPORTER_SOURCES,
} from "@/lib/masschallenge/source-discovery";
import { validateAndExtractParticipantSource } from "@/lib/masschallenge/source-validation";
import {
  deserializeSourceWorkResult,
  serializeSourceWorkResultForCache,
  type SafeCachedSourceWorkResult,
  type SourceWorkResult,
} from "@/lib/masschallenge/source-cache-serialization";
import { mapWithConcurrency, SameHostRateLimiter } from "@/lib/500-global/rate-limiter";
import {
  validateMassChallengeWorkbook,
  writeMassChallengeWorkbook,
  type ExcludedExportRow,
  type BlockedSourceExportRow,
  type NeedsReviewExportRow,
} from "@/lib/masschallenge/xlsx-export";
import { resolveCountry } from "@/lib/geography";
import {
  extractMassChallengeRosterLocation,
  resolveMassChallengeRosterLocation,
} from "@/lib/masschallenge/roster-location";

const COVERAGE_STATEMENT =
  "All matching companies found from verified official sources currently discovered and supported by the exporter.";
const CACHE_DIRECTORY = path.resolve(process.cwd(), ".cache", "masschallenge");
const MAX_SOURCE_CANDIDATES = 100;
const USER_AGENT =
  "FounderEmailVerifier/1.0 standalone-masschallenge-lead-exporter";

export type CliOptions = {
  stage: "discover" | "filter" | "enrich" | "all";
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
  console.log(
    `MassChallenge exporter: stage=${options.stage} years=${options.years.join(",")} regions=${options.regions.join(",")} ${options.resume ? "resume" : options.fresh ? "fresh" : "standard"}`,
  );
  if (options.stage === "discover" || options.stage === "all") {
    await runDiscoverStage(options);
  }
  if (options.stage === "filter" || options.stage === "all") {
    await runFilterStage(options);
  }
  if (options.stage === "enrich" || options.stage === "all") {
    await runEnrichStage(options);
  }
}

async function runDiscoverStage(options: CliOptions) {
  const transport = createTransport(options);
  const cache = await openStageCache("discover", options, {
    catalog: MAINTAINED_EXPORTER_SOURCES,
    approvedPartnerHosts: APPROVED_EXPORTER_PARTNER_HOSTS,
  });
  console.log("\nStage 1/3 — discovering official MassChallenge companies...");
  const discovery = await discoverOfficialSourceCandidates({
    years: options.years,
    fetchIndex: async (url) => {
      const response = await fetchOfficialDiscoveryHtml(url, {}, transport);
      return { html: response.html, finalUrl: response.finalUrl };
    },
    searchProvider: createBraveSourceSearchProvider(),
  });
  console.log(`Official source URLs discovered (${discovery.candidates.length}):`);
  for (const candidate of discovery.candidates) {
    console.log(`- ${candidate.url}`);
  }
  const sourceResults = await processSourceQueue(
    discovery.candidates,
    options,
    cache,
    transport,
  );
  const extractions = sourceResults
    .map((result) => result.extraction)
    .filter((value): value is ValidatedSourceExtraction => value !== null);
  const extractedCount = extractions.reduce(
    (total, extraction) => total + extraction.participants.length,
    0,
  );
  const merged = mergeValidatedSourceExtractions(extractions);
  const accepted = merged.companies;
  printSourceCoverage(extractions);
  const blockedSources = sourceResults
    .filter((result) => ["failed", "retry_wait", "robots_blocked", "cache_error"].includes(result.status))
    .map(toBlockedSourceRow);
  const sourceWarnings = sourceResults.filter(isAmbiguousSourceResult).map(toSourceWarningRow);
  const excludedSources = sourceResults
    .filter((result) => result.status === "rejected" && !isAmbiguousSourceResult(result))
    .map(toRejectedSourceRow);
  const duplicateAudit = merged.duplicates.map(toDuplicateRow);
  const coverageWarnings = buildDiscoveryCoverageWarnings(
    options.years,
    discovery.warnings,
    sourceResults,
  );
  const document: DiscoveredMassChallengeDocument = {
    schema_version: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
    stage: "discover",
    generated_at: new Date().toISOString(),
    years: [...options.years],
    companies: accepted.map(toDiscoveredCompany),
    source_summary: {
      sources_discovered: sourceResults.length,
      sources_validated: extractions.length,
      sources_processed: sourceResults.filter((result) => result.fetch !== null).length,
      official_companies_extracted: extractedCount,
      unique_companies: accepted.length,
      duplicates_merged: merged.duplicates.filter((item) => /Duplicate participant merged/i.test(item.reason)).length,
      sources_blocked: blockedSources.length,
      roster_locations_recognized: accepted.filter((company) =>
        Boolean(
          resolveMassChallengeRosterLocation(company.listedCountry) ??
          extractMassChallengeRosterLocation(company.description),
        ),
      ).length,
    },
    blocked_sources: blockedSources,
    source_warnings: sourceWarnings,
    excluded_sources: excludedSources,
    duplicate_audit: duplicateAudit,
    coverage_warnings: coverageWarnings,
  };
  const outputPath = discoveredDatasetPath();
  await writeStageDocument(outputPath, document);
  cache.setCoverageWarnings(coverageWarnings);
  await cache.save();
  console.log("Stage 1 complete");
  console.log(`Sources discovered: ${document.source_summary.sources_discovered}`);
  console.log(`Sources validated: ${document.source_summary.sources_validated}`);
  console.log(`Sources processed: ${document.source_summary.sources_processed}`);
  console.log(`Official companies extracted: ${document.source_summary.official_companies_extracted}`);
  console.log(`Unique companies: ${document.source_summary.unique_companies}`);
  console.log(`Duplicates merged: ${document.source_summary.duplicates_merged}`);
  console.log(`Sources blocked: ${document.source_summary.sources_blocked}`);
  console.log(`Roster locations recognized: ${document.source_summary.roster_locations_recognized}`);
  console.log(`Output path: ${outputPath}`);
}

async function runFilterStage(options: CliOptions) {
  const discovered = await readDiscoveredDocument();
  assertCompatibleYears(discovered.years, options.years, "Stage 1");
  const transport = createTransport(options);
  const cache = await openStageCache("filter", options, {
    discoveredFingerprint: createOptionsFingerprint(discovered.companies),
  });
  console.log("\nStage 2/3 — classifying company geography...");
  let completed = 0;
  const filteredCompanies = await mapWithConcurrency(
    discovered.companies,
    async (company) => {
      const record = discoveredToCompanyRecord(company);
      const work = await processCompany(record, options, cache, transport, false);
      completed += 1;
      console.log(`Geography ${completed}/${discovered.companies.length}: ${company.company_name}`);
      return toFilteredCompany(company, work.enrichment, options.regions);
    },
    options.companyConcurrency,
  );
  const document: FilteredMassChallengeDocument = {
    schema_version: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
    stage: "filter",
    generated_at: new Date().toISOString(),
    years: [...options.years],
    regions: [...options.regions],
    companies: filteredCompanies,
    blocked_sources: discovered.blocked_sources,
    source_warnings: discovered.source_warnings,
    excluded_sources: discovered.excluded_sources,
    duplicate_audit: discovered.duplicate_audit,
    coverage_warnings: [...new Set([...discovered.coverage_warnings, STAGE_TWO_LIMIT_WARNING])],
  };
  const jsonPath = filteredDatasetPath();
  const workbookPath = path.resolve(process.cwd(), "exports", "MassChallenge_2025_2026_Companies.xlsx");
  await writeStageDocument(jsonPath, document);
  const counts = await writeMassChallengeCompanyWorkbook(document, workbookPath);
  console.log("Stage 2 complete");
  console.log(`Companies classified: ${document.companies.length}`);
  console.log(`Europe and North America: ${counts.target}`);
  console.log(`Roster locations recognized: ${document.companies.filter((company) => company.roster_location_evidence).length}`);
  console.log(`Unresolved/conflicting location: ${counts.unresolved}`);
  console.log(`Excluded geography: ${counts.excluded}`);
  console.log(`Blocked sources: ${counts.blocked}`);
  console.log(`JSON output: ${jsonPath}`);
  console.log(`Workbook output: ${workbookPath}`);
}

async function runEnrichStage(options: CliOptions) {
  const filtered = await readFilteredDocument();
  assertCompatibleYears(filtered.years, options.years, "Stage 2");
  const eligible = filtered.companies.filter((company) =>
    company.location_classification === "europe" ||
    company.location_classification === "north_america",
  );
  const transport = createTransport(options);
  const cache = await openStageCache("enrich", options, {
    filteredFingerprint: createOptionsFingerprint(filtered.companies),
  });
  console.log("\nStage 3/3 — enriching founders for eligible companies...");
  let completed = 0;
  const finalCompanies = await mapWithConcurrency(
    eligible,
    async (company) => {
      const work = await processCompany(
        filteredToCompanyRecord(company),
        options,
        cache,
        transport,
        true,
      );
      completed += 1;
      console.log(`Founder enrichment ${completed}/${eligible.length}: ${company.company_name}`);
      return preserveFilteredLocation(toFinalCompany(work), company);
    },
    options.companyConcurrency,
  );
  const classified = classifyFinalCompanies(finalCompanies, options.years, options.regions);
  const needsReview = [
    ...classified.needsReview.map(toNeedsReviewRow),
    ...filtered.source_warnings,
  ];
  const unresolvedLocation = filtered.companies
    .filter((company) =>
      company.location_classification === "unresolved_location" ||
      company.location_classification === "conflicting_location",
    )
    .map(toUnresolvedLocationRow);
  const excluded = [
    ...classified.excluded.map(toExcludedCompanyRow),
    ...filtered.companies
      .filter((company) => company.location_classification === "outside_target_region")
      .map(toFilteredExcludedRow),
    ...filtered.duplicate_audit,
    ...filtered.excluded_sources,
  ];
  const coverageWarnings = buildCoverageWarnings({
    baseWarnings: filtered.coverage_warnings,
    finalCompanies,
    readyCount: classified.ready.length,
  });
  const outputPath = path.resolve(process.cwd(), "exports", outputFilename(options));
  const compatibility = await writeMassChallengeWorkbook({
    outputPath,
    ready: classified.ready,
    needsReview,
    unresolvedLocation,
    excluded,
    blockedSources: filtered.blocked_sources,
    coverageWarnings,
  });
  await validateMassChallengeWorkbook(outputPath, classified.ready);
  console.log("Stage 3 complete");
  console.log(`Eligible companies read from Stage 2: ${eligible.length}`);
  console.log(`Ready for Upload: ${classified.ready.length}`);
  console.log(`Needs Founder Review companies: ${classified.needsReview.length}`);
  console.log(`Unresolved Location companies: ${unresolvedLocation.length}`);
  console.log(`Active founders parsed by upload validation: ${compatibility.parsedFounders}`);
  console.log(`Blocked sources retained: ${filtered.blocked_sources.length}`);
  console.log(`Output path: ${outputPath}`);
}

function createTransport(options: CliOptions): SafeFetchTransportOptions {
  const limiter = new SameHostRateLimiter({ minimumSpacingMs: options.hostSpacingMs });
  return {
    beforeRequest: (url) => limiter.wait(url).then(() => undefined),
    userAgent: USER_AGENT,
    robotsCache: new Map(),
    onRetryAfter: (url, retryAt) => limiter.deferUntil(url, retryAt),
  };
}

function openStageCache(stage: "discover" | "filter" | "enrich", options: CliOptions, inputs: object) {
  return openExporterCache({
    directory: path.resolve(CACHE_DIRECTORY, stage),
    optionsFingerprint: createOptionsFingerprint({
      schemaVersion: MASSCHALLENGE_STAGE_SCHEMA_VERSION,
      stage,
      years: options.years,
      regions: stage === "discover" ? undefined : options.regions,
      ...inputs,
    }),
    fresh: options.fresh,
  });
}

function toDiscoveredCompany(company: ExporterCompanyRecord): DiscoveredMassChallengeCompany {
  const rosterLocation =
    resolveMassChallengeRosterLocation(company.listedCountry) ??
    extractMassChallengeRosterLocation(company.description);
  return {
    company_name: company.companyName,
    website: company.website,
    normalized_domain: company.normalizedDomain,
    accelerator_batch: company.acceleratorBatch,
    accelerator_year: company.acceleratorYear,
    program_name: company.acceleratorBatch,
    listed_location: rosterLocation?.listedLocation ?? company.listedCountry,
    listed_location_evidence: rosterLocation
      ? "company_specific"
      : company.listedCountryEvidence,
    canonical_country: rosterLocation?.canonicalCountry ?? null,
    country_iso2: rosterLocation?.countryIso2 ?? null,
    roster_location_evidence: rosterLocation
      ? {
          authority: "masschallenge_official",
          evidence_type: "participant_listing",
          listed_location: rosterLocation.listedLocation,
          canonical_country: rosterLocation.canonicalCountry,
          country_iso2: rosterLocation.countryIso2,
          region: rosterLocation.region,
          confidence: rosterLocation.confidence,
          source_url: company.sourceUrl,
        }
      : null,
    industry: company.industry,
    description: company.description,
    source_url: company.sourceUrl,
    additional_source_urls: company.supportingSourceUrls.filter((url) => url !== company.sourceUrl),
    program_associations: (company.programAssociations ?? []).map(
      (association) => ({
        program: association.program,
        year: association.year,
        source_url: association.sourceUrl,
        participant_status: association.participantStatus,
      }),
    ),
    source_kind: company.sourceKind,
    discovery_status: "official_confirmed",
    discovery_warnings: [...new Set(company.warnings)],
  };
}

function discoveredToCompanyRecord(company: DiscoveredMassChallengeCompany): ExporterCompanyRecord {
  const rosterLocation =
    company.roster_location_evidence ??
    (() => {
      const resolved =
        resolveMassChallengeRosterLocation(company.listed_location) ??
        extractMassChallengeRosterLocation(company.description);
      return resolved
        ? {
            canonical_country: resolved.canonicalCountry,
            listed_location: resolved.listedLocation,
          }
        : null;
    })();
  return {
    companyName: company.company_name,
    website: company.website,
    normalizedDomain: company.normalized_domain,
    acceleratorName: "MassChallenge",
    acceleratorBatch: company.accelerator_batch,
    acceleratorYear: company.accelerator_year,
    sourceUrl: company.source_url,
    sourceKind: company.source_kind,
    officialMembershipStatus: "confirmed",
    listedCountry:
      rosterLocation?.canonical_country ?? company.listed_location,
    listedCountryEvidence: rosterLocation
      ? "company_specific"
      : company.listed_location_evidence,
    industry: company.industry,
    description: company.description,
    founders: [],
    supportingSourceUrls: [company.source_url, ...company.additional_source_urls],
    programAssociations: company.program_associations.map((association) => ({
      program: association.program,
      year: association.year,
      sourceUrl: association.source_url,
      participantStatus: association.participant_status,
    })),
    extractionStrategies: [],
    warnings: [...company.discovery_warnings],
    evidenceStrength: 100,
  };
}

function filteredToCompanyRecord(company: FilteredMassChallengeCompany): ExporterCompanyRecord {
  return discoveredToCompanyRecord(company);
}

function toFilteredCompany(
  company: DiscoveredMassChallengeCompany,
  enrichment: CompanyEnrichmentResult,
  targetRegions: readonly ExporterRegion[],
): FilteredMassChallengeCompany {
  const resolvedRoster =
    company.roster_location_evidence ??
    (() => {
      const resolved =
        resolveMassChallengeRosterLocation(company.listed_location) ??
        extractMassChallengeRosterLocation(company.description);
      return resolved
        ? {
            authority: "masschallenge_official" as const,
            evidence_type: "participant_listing" as const,
            listed_location: resolved.listedLocation,
            canonical_country: resolved.canonicalCountry,
            country_iso2: resolved.countryIso2,
            region: resolved.region,
            confidence: resolved.confidence,
            source_url: company.source_url,
          }
        : null;
    })();
  const classification: MassChallengeLocationClassification =
    enrichment.locationStatus === "conflicting"
      ? "conflicting_location"
      : !enrichment.headquartersCountry
        ? "unresolved_location"
        : enrichment.headquartersRegion && targetRegions.includes(enrichment.headquartersRegion)
          ? enrichment.headquartersRegion
          : "outside_target_region";
  return {
    ...company,
    listed_location: resolvedRoster?.listed_location ?? company.listed_location,
    listed_location_evidence: resolvedRoster
      ? "company_specific"
      : company.listed_location_evidence,
    roster_location_evidence: resolvedRoster,
    website: enrichment.canonicalWebsite ?? company.website,
    canonical_country: enrichment.headquartersCountry,
    country_iso2: enrichment.headquartersIso2,
    location_classification: classification,
    location_evidence: [
      ...(resolvedRoster
        ? [
            `${resolvedRoster.listed_location} → ${resolvedRoster.canonical_country} (masschallenge_official, participant_listing, confidence ${resolvedRoster.confidence.toFixed(2)}; ${resolvedRoster.source_url})`,
          ]
        : []),
      ...enrichment.locationEvidence.map(
      (evidence) => `${evidence.country.canonicalName} (${evidence.authority}, ${evidence.evidenceType}) — ${evidence.snippet}`,
      ),
    ],
    location_warnings: enrichment.warnings,
    company_pages_checked: enrichment.pages.map((page) => page.url),
    company_site_failures: enrichment.failures.map((failure) => `${failure.url}: ${failure.reason}`),
  };
}

function preserveFilteredLocation(
  company: ExporterFinalCompany,
  filtered: FilteredMassChallengeCompany,
): ExporterFinalCompany {
  return {
    ...company,
    website: filtered.website,
    headquartersCountry: filtered.canonical_country,
    headquartersIso2: filtered.country_iso2,
    headquartersRegion:
      filtered.location_classification === "europe" ||
      filtered.location_classification === "north_america"
        ? filtered.location_classification
        : null,
    locationStatus: "confirmed",
    locationEvidence: [...new Set([...filtered.location_evidence, ...company.locationEvidence])],
    reviewReasons: company.reviewReasons.filter((reason) => !/location/i.test(reason)),
  };
}

function toFilteredExcludedRow(company: FilteredMassChallengeCompany): ExcludedExportRow {
  return {
    record_type: "company",
    excluded_company_name: company.company_name,
    excluded_website: company.website ?? "",
    accelerator_year: company.accelerator_year,
    exclusion_reason: `Confirmed company location${company.canonical_country ? ` in ${company.canonical_country}` : ""} is outside the requested regions.`,
    listed_country: company.listed_location ?? company.canonical_country ?? "",
    normalized_region: "outside_supported_regions",
    source_url: company.source_url,
    source_kind: company.source_kind,
  };
}

function toUnresolvedLocationRow(
  company: FilteredMassChallengeCompany,
): NeedsReviewExportRow {
  return {
    record_type: "company",
    review_company_name: company.company_name,
    review_website: company.website ?? "",
    accelerator_batch: company.accelerator_batch ?? "",
    accelerator_year: company.accelerator_year,
    country: company.canonical_country ?? company.listed_location ?? "",
    industry: company.industry ?? "",
    description: company.description ?? "",
    review_reasons:
      company.location_classification === "conflicting_location"
        ? "Company headquarters/current-location evidence conflicts."
        : "Company headquarters/current location could not be confirmed.",
    location_evidence: company.location_evidence.join(" | "),
    additional_source_urls: company.additional_source_urls.join(" | "),
    source_kind: company.source_kind,
    source_url: company.source_url,
  };
}

function assertCompatibleYears(
  actual: readonly ExporterYear[],
  expected: readonly ExporterYear[],
  label: string,
) {
  if ([...actual].sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} output was created for years ${actual.join(",")}; rerun the preceding stage for ${expected.join(",")}.`);
  }
}

function buildDiscoveryCoverageWarnings(
  years: readonly ExporterYear[],
  discoveryWarnings: readonly string[],
  sourceResults: readonly SourceWorkResult[],
) {
  const warnings = [COVERAGE_STATEMENT, ...discoveryWarnings];
  for (const year of years) {
    if (!sourceResults.some((result) => result.extraction?.source.acceleratorYear === year)) {
      warnings.push(`No verified participant roster was processed for ${year}.`);
    }
    warnings.push(`${year} coverage is partial; maintained sources and supported discovery do not prove complete worldwide coverage.`);
  }
  for (const result of sourceResults) {
    for (const warning of result.validation?.warnings ?? []) {
      warnings.push(`${result.candidate.url}: ${warning}`);
    }
    for (const warning of result.extraction?.warnings ?? []) {
      warnings.push(`${result.candidate.url}: ${warning}`);
    }
  }
  const blocked = sourceResults.filter((result) =>
    ["failed", "retry_wait", "robots_blocked", "cache_error"].includes(result.status),
  ).length;
  if (blocked) warnings.push(`${blocked} official source candidate${blocked === 1 ? "" : "s"} could not be processed.`);
  return [...new Set(warnings)].slice(0, 250);
}

function printSourceCoverage(extractions: readonly ValidatedSourceExtraction[]) {
  console.log(`Validated cohort sources (${extractions.length}):`);
  for (const extraction of extractions) {
    console.log(
      `- ${extraction.source.acceleratorYear} | ${extraction.source.acceleratorBatch ?? extraction.source.pageTitle ?? "Program unavailable"} | ${extraction.participants.length} companies | ${extraction.source.url}`,
    );
  }
  console.log("Coverage by year:");
  for (const year of [2025, 2026] as const) {
    const sources = extractions.filter((item) => item.source.acceleratorYear === year);
    console.log(
      `- ${year}: ${sources.length} validated sources; ${sources.reduce((total, item) => total + item.participants.length, 0)} extracted company records`,
    );
  }
  console.log("Coverage by MassChallenge program:");
  const programs = new Map<string, { sources: Set<string>; companies: number }>();
  for (const extraction of extractions) {
    const name = extraction.source.acceleratorBatch ?? extraction.source.pageTitle ?? "Program unavailable";
    const value = programs.get(name) ?? { sources: new Set<string>(), companies: 0 };
    value.sources.add(extraction.source.url);
    value.companies += extraction.participants.length;
    programs.set(name, value);
  }
  for (const [program, value] of [...programs].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`- ${program}: ${value.companies} company records across ${value.sources.size} source(s)`);
  }
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
  includeFounders = true,
): Promise<CompanyWorkResult> {
  const key = companyKey(company);
  const cached = cache.get<CompanyEnrichmentResult>("companies", key);
  const listedCountry = company.listedCountry
    ? resolveCountry(company.listedCountry)
    : null;
  if (
    shouldUseLocationOnlyEnrichment(
      includeFounders,
      company.listedCountryEvidence,
      Boolean(listedCountry),
    )
  ) {
    const enrichment = locationOnlyEnrichment(
      company,
      listedCountry!,
      includeFounders,
    );
    if (options.resume && cached && cached.status !== "completed") {
      cache.markCompleted("companies", key, enrichment);
      await cache.save();
    }
    return {
      company,
      enrichment,
      enrichmentSkipped: true,
    };
  }

  if (options.resume && cached?.status === "completed" && cached.value) {
    if (
      !includeFounders ||
      isCompletedFounderEnrichmentCacheValue(company, cached.value)
    ) {
      return { company, enrichment: cached.value, enrichmentSkipped: false };
    }
    cache.set("companies", key, {
      status: "pending",
      attempts: cached.attempts,
      value: cached.value,
      error:
        "Cached location-only result requires company-site founder enrichment.",
    });
    await cache.save();
  }
  if (!includeFounders && options.resume && cached?.value) {
    cache.markCompleted("companies", key, cached.value);
    await cache.save();
    return { company, enrichment: cached.value, enrichmentSkipped: false };
  }
  if (!includeFounders && options.resume && cached?.status === "processing") {
    const enrichment = failedEnrichment(
      company,
      "A prior Stage 2 website check was interrupted; location remains unresolved for review.",
    );
    cache.markCompleted("companies", key, enrichment);
    await cache.save();
    return { company, enrichment, enrichmentSkipped: false };
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
    const controller = includeFounders ? null : new AbortController();
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const enrichmentPromise = enrichStandaloneCompany(
      {
        companyName: company.companyName,
        website: company.website,
        listedCountry:
          company.listedCountryEvidence === "company_specific"
            ? company.listedCountry
            : null,
        listedCountryEvidence: company.listedCountryEvidence,
        officialSourceUrl: company.sourceUrl,
        officialRosterAuthority: "masschallenge_official",
        includeFounders,
        sourceFounders: company.founders.map((founder) => ({
          name: founder.founderName,
          role: founder.founderRole,
          linkedinUrl: founder.linkedinUrl,
          sourceUrl: founder.sourceUrl,
        })),
      },
      {
        maxPages: includeFounders
          ? undefined
          : MASSCHALLENGE_STAGE_TWO_MAX_WEBSITE_CHECKS,
        fetchHtml: async (url, context) => {
          const fetched = await fetchCompanyEnrichmentHtml(
            url,
            context.companyUrl,
            {},
            controller ? { ...transport, signal: controller.signal } : transport,
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
    const enrichment = includeFounders
      ? await enrichmentPromise
      : await Promise.race([
          enrichmentPromise,
          new Promise<CompanyEnrichmentResult>((resolve) => {
            deadline = setTimeout(() => {
              controller?.abort();
              resolve(
                failedEnrichment(
                  company,
                  "Stage 2 website check exceeded 20 seconds; location remains unresolved for review.",
                ),
              );
            }, MASSCHALLENGE_STAGE_TWO_COMPANY_TIMEOUT_MS);
          }),
        ]);
    if (deadline) clearTimeout(deadline);
    if (!includeFounders) {
      cache.markCompleted("companies", key, enrichment);
      await cache.save();
      return { company, enrichment, enrichmentSkipped: false };
    }
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
    if (includeFounders) {
      cache.markFailed(
        "companies",
        key,
        enrichment,
        sanitizeError(error),
      );
    } else {
      cache.markCompleted("companies", key, enrichment);
    }
    await cache.save();
    return { company, enrichment, enrichmentSkipped: false };
  }
}

export function shouldUseLocationOnlyEnrichment(
  includeFounders: boolean,
  listedCountryEvidence: ExporterCompanyRecord["listedCountryEvidence"],
  hasResolvedListedCountry: boolean,
) {
  return (
    !includeFounders &&
    listedCountryEvidence === "company_specific" &&
    hasResolvedListedCountry
  );
}

export function isCompletedFounderEnrichmentCacheValue(
  company: Pick<ExporterCompanyRecord, "website" | "normalizedDomain">,
  enrichment: Pick<CompanyEnrichmentResult, "pagesAttempted">,
) {
  if (!company.website || !company.normalizedDomain) return true;
  return enrichment.pagesAttempted.length > 0;
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
  includeFounders = true,
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
        authority: "masschallenge_official",
        evidenceType: "participant_listing",
      },
    ],
    founders: includeFounders ? company.founders.map((founder) => ({
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
    })) : [],
    activeFounders: [],
    warnings: includeFounders
      ? ["Company-site founder enrichment was skipped because the verified company location is outside the requested regions."]
      : [],
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
  baseWarnings: readonly string[];
  finalCompanies: readonly ExporterFinalCompany[];
  readyCount: number;
}) {
  const warnings = [COVERAGE_STATEMENT, ...input.baseWarnings];
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
  const validationReasons = result.validation?.reasonCodes.join(", ");
  return {
    record_type: "source_warning",
    review_company_name:
      result.candidate.acceleratorBatchHint ?? "Unprocessed official source candidate",
    accelerator_year: result.candidate.acceleratorYearHint ?? "",
    review_reasons:
      validationReasons ??
      result.error ??
      "The source has ambiguous cohort-year evidence and requires review.",
    source_kind: result.candidate.sourceKindHint ?? "",
    extraction_strategy: result.candidate.strategyHints?.join(" | ") ?? "",
    source_url: result.candidate.url,
  };
}

function isAmbiguousSourceResult(result: SourceWorkResult) {
  return Boolean(
    result.validation?.reasonCodes.some((reason) =>
      reason === "ambiguous_year" || reason === "year_conflict",
    ),
  );
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
  return `MassChallenge_${years}_${regions}.xlsx`;
}

export function parseArguments(values: readonly string[]): CliOptions | null {
  if (values.includes("--help") || values.includes("-h")) {
    printHelp();
    return null;
  }
  const options: CliOptions = {
    stage: "all",
    years: [2025, 2026],
    regions: ["europe", "north_america"],
    resume: false,
    fresh: false,
    sourceConcurrency: 1,
    companyConcurrency: 2,
    hostSpacingMs: 2_000,
  };
  for (const value of values) {
    if (value.startsWith("--stage=")) {
      const stage = value.slice("--stage=".length);
      if (!["discover", "filter", "enrich", "all"].includes(stage)) {
        throw new Error("--stage must be discover, filter, enrich, or all.");
      }
      options.stage = stage as CliOptions["stage"];
      continue;
    }
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
  console.log(`Usage: npm run lead:masschallenge -- [options]

Options:
  --stage=discover|filter|enrich|all Workflow stage (default: all)
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
    console.error(`MassChallenge exporter failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}
