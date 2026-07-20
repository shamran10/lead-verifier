import { isDeepStrictEqual } from "node:util";

import type {
  ExporterExtractionStrategy,
  ExporterSourceKind,
  ExporterYear,
  ExtractedExporterParticipant,
  SourceCandidate,
  SourceDiscoveryOrigin,
  SourceValidationReasonCode,
  SourceValidationResult,
  ValidatedExporterSource,
  ValidatedSourceExtraction,
} from "@/lib/500-global/exporter-types";
import {
  EXPORTER_EXTRACTION_STRATEGIES,
  EXPORTER_SOURCE_KINDS,
} from "@/lib/500-global/exporter-types";

const SOURCE_CACHE_SCHEMA_VERSION = 1 as const;
const SOURCE_WORK_STATUSES = [
  "validated",
  "rejected",
  "failed",
  "retry_wait",
  "robots_blocked",
  "cache_error",
] as const;
const DISCOVERY_ORIGINS = [
  "catalog",
  "official_index",
  "verified_source_link",
  "search_provider",
  "manual",
] as const;
const VALIDATION_REASONS: readonly SourceValidationReasonCode[] = [
  "invalid_url",
  "unapproved_host",
  "unsupported_year",
  "ambiguous_year",
  "year_conflict",
  "unsupported_source_kind",
  "missing_500_global_attribution",
  "application_only",
  "general_program_only",
  "historical_portfolio",
  "no_participant_assertion",
  "unbounded_participant_section",
  "no_extractable_participants",
  "participant_count_mismatch",
];

export type SourceWorkStatus = (typeof SOURCE_WORK_STATUSES)[number];

export type SourceFetchMetadata = {
  finalUrl: string;
  status: number;
  contentType: string;
  contentHash: string;
  fetchedAt: string;
  redirectCount: number;
};

export type SourceWorkResult = {
  candidate: SourceCandidate;
  status: SourceWorkStatus;
  fetch: SourceFetchMetadata | null;
  validation: SourceValidationResult | null;
  extraction: ValidatedSourceExtraction | null;
  linkedCandidates: SourceCandidate[];
  error: string | null;
};

type SafeCachedSourceCandidate = {
  url: string;
  originalUrl: string | null;
  origin: SourceDiscoveryOrigin | null;
  discoveredFrom: string | null;
  sourceKindHint: ExporterSourceKind | null;
  acceleratorYearHint: number | null;
  acceleratorBatchHint: string | null;
  strategyHints: ExporterExtractionStrategy[];
  expectedMinimumCompanies: number | null;
  expectedApproximateCompanies: number | null;
};

type SafeCachedValidatedSource = {
  url: string;
  originalUrl: string;
  hostname: string;
  sourceKind: ExporterSourceKind;
  acceleratorYear: ExporterYear;
  acceleratorBatch: string | null;
  pageTitle: string | null;
  publishedDate: string | null;
  strategies: ExporterExtractionStrategy[];
  expectedMinimumCompanies: number | null;
  expectedApproximateCompanies: number | null;
  warnings: string[];
};

type SafeCachedParticipant = Omit<
  ExtractedExporterParticipant,
  "evidenceSnippet"
>;

type SafeCachedValidation = {
  disposition: SourceValidationResult["disposition"];
  accepted: boolean;
  source: SafeCachedValidatedSource | null;
  reasonCodes: SourceValidationReasonCode[];
  warnings: string[];
  probes: Array<{
    strategy: ExporterExtractionStrategy;
    markerFound: boolean;
    boundedSectionCount: number;
    candidateCount: number;
    confidence: number;
    warnings: string[];
  }>;
};

type SafeCachedExtraction = {
  source: SafeCachedValidatedSource;
  participants: SafeCachedParticipant[];
  warnings: string[];
};

export type SafeCachedSourceWorkResult = {
  cacheSchemaVersion: typeof SOURCE_CACHE_SCHEMA_VERSION;
  serializedAt: string;
  candidate: SafeCachedSourceCandidate;
  status: SourceWorkStatus;
  fetch: SourceFetchMetadata | null;
  validation: SafeCachedValidation | null;
  extraction: SafeCachedExtraction | null;
  linkedCandidates: SafeCachedSourceCandidate[];
  error: string | null;
  robotsBlocked: boolean;
  claimedParticipantCount: number | null;
  extractedParticipantCount: number;
};

/**
 * Converts the larger runtime source result into the only shape permitted in
 * the persistent cache. Every nested field is explicitly allowlisted.
 */
export function serializeSourceWorkResultForCache(
  value: unknown,
  now: () => number = Date.now,
): SafeCachedSourceWorkResult | null {
  const object = recordValue(value);
  const candidate = serializeCandidate(object?.candidate);
  const status = enumValue(object?.status, SOURCE_WORK_STATUSES);
  if (!object || !candidate || !status) return null;

  const extraction = serializeExtraction(object.extraction);
  const serializedAt = isoTimestamp(object.serializedAt) ?? new Date(now()).toISOString();
  return {
    cacheSchemaVersion: SOURCE_CACHE_SCHEMA_VERSION,
    serializedAt,
    candidate,
    status,
    fetch: serializeFetch(object.fetch),
    validation: serializeValidation(object.validation),
    extraction,
    linkedCandidates: arrayValue(object.linkedCandidates)
      .map(serializeCandidate)
      .filter((item): item is SafeCachedSourceCandidate => item !== null)
      .slice(0, 100),
    error: sanitizedText(object.error, 500),
    robotsBlocked: status === "robots_blocked",
    claimedParticipantCount:
      positiveInteger(candidate.expectedApproximateCompanies) ??
      positiveInteger(candidate.expectedMinimumCompanies),
    extractedParticipantCount: extraction?.participants.length ?? 0,
  };
}

export function assertSafeSerializedSourceCacheValue(
  value: unknown,
): asserts value is SafeCachedSourceWorkResult {
  const canonical = serializeSourceWorkResultForCache(value);
  if (!canonical || !isDeepStrictEqual(value, canonical)) {
    throw new Error(
      "Source cache values must use the explicit safe serialized schema.",
    );
  }
}

export function deserializeSourceWorkResult(
  value: unknown,
): SourceWorkResult | null {
  const cached = serializeSourceWorkResultForCache(value);
  if (!cached) return null;
  return {
    candidate: deserializeCandidate(cached.candidate),
    status: cached.status,
    fetch: cached.fetch,
    validation: cached.validation
      ? {
          ...cached.validation,
          source: cached.validation.source
            ? deserializeValidatedSource(cached.validation.source)
            : null,
        }
      : null,
    extraction: cached.extraction
      ? {
          source: deserializeValidatedSource(cached.extraction.source),
          participants: cached.extraction.participants.map((participant) => ({
            ...participant,
            evidenceSnippet: "",
          })),
          strategyResults: [],
          warnings: cached.extraction.warnings,
        }
      : null,
    linkedCandidates: cached.linkedCandidates.map(deserializeCandidate),
    error: cached.error,
  };
}

function deserializeCandidate(candidate: SafeCachedSourceCandidate): SourceCandidate {
  return {
    ...candidate,
    origin: candidate.origin ?? undefined,
  };
}

function serializeCandidate(value: unknown): SafeCachedSourceCandidate | null {
  const object = recordValue(value);
  const url = safeHttpsUrl(object?.url);
  if (!object || !url) return null;
  return {
    url,
    originalUrl: safeHttpsUrl(object.originalUrl),
    origin: enumValue(object.origin, DISCOVERY_ORIGINS),
    discoveredFrom: safeHttpsUrl(object.discoveredFrom),
    sourceKindHint: enumValue(object.sourceKindHint, EXPORTER_SOURCE_KINDS),
    acceleratorYearHint: finiteInteger(object.acceleratorYearHint),
    acceleratorBatchHint: sanitizedText(object.acceleratorBatchHint, 160),
    strategyHints: arrayValue(object.strategyHints)
      .map((item) => enumValue(item, EXPORTER_EXTRACTION_STRATEGIES))
      .filter((item): item is ExporterExtractionStrategy => item !== null),
    expectedMinimumCompanies: positiveInteger(object.expectedMinimumCompanies),
    expectedApproximateCompanies: positiveInteger(
      object.expectedApproximateCompanies,
    ),
  };
}

function serializeFetch(value: unknown): SourceFetchMetadata | null {
  const object = recordValue(value);
  const finalUrl = safeHttpsUrl(object?.finalUrl);
  const status = finiteInteger(object?.status);
  const fetchedAt = isoTimestamp(object?.fetchedAt);
  const contentHash = sanitizedText(object?.contentHash, 128);
  if (!object || !finalUrl || status === null || !fetchedAt || !contentHash) {
    return null;
  }
  return {
    finalUrl,
    status,
    contentType: sanitizedText(object.contentType, 120) ?? "",
    contentHash,
    fetchedAt,
    redirectCount: Math.max(0, finiteInteger(object.redirectCount) ?? 0),
  };
}

function serializeValidation(value: unknown): SafeCachedValidation | null {
  const object = recordValue(value);
  const disposition = enumValue(object?.disposition, [
    "accepted",
    "rejected",
    "needs_review",
  ] as const);
  if (!object || !disposition || typeof object.accepted !== "boolean") return null;
  return {
    disposition,
    accepted: object.accepted,
    source: serializeValidatedSource(object.source),
    reasonCodes: arrayValue(object.reasonCodes)
      .map((item) => enumValue(item, VALIDATION_REASONS))
      .filter((item): item is SourceValidationReasonCode => item !== null),
    warnings: warningArray(object.warnings),
    probes: arrayValue(object.probes)
      .map(serializeProbe)
      .filter((item): item is NonNullable<ReturnType<typeof serializeProbe>> =>
        Boolean(item),
      ),
  };
}

function serializeProbe(value: unknown) {
  const object = recordValue(value);
  const strategy = enumValue(object?.strategy, EXPORTER_EXTRACTION_STRATEGIES);
  if (!object || !strategy) return null;
  return {
    strategy,
    markerFound: object.markerFound === true,
    boundedSectionCount: Math.max(0, finiteInteger(object.boundedSectionCount) ?? 0),
    candidateCount: Math.max(0, finiteInteger(object.candidateCount) ?? 0),
    confidence: boundedConfidence(object.confidence),
    warnings: warningArray(object.warnings),
  };
}

function serializeValidatedSource(
  value: unknown,
): SafeCachedValidatedSource | null {
  const object = recordValue(value);
  const url = safeHttpsUrl(object?.url);
  const originalUrl = safeHttpsUrl(object?.originalUrl);
  const sourceKind = enumValue(object?.sourceKind, EXPORTER_SOURCE_KINDS);
  const acceleratorYear = enumValue(object?.acceleratorYear, [2025, 2026] as const);
  if (!object || !url || !originalUrl || !sourceKind || !acceleratorYear) return null;
  return {
    url,
    originalUrl,
    hostname: sanitizedHostname(object.hostname) ?? new URL(url).hostname,
    sourceKind,
    acceleratorYear,
    acceleratorBatch: sanitizedText(object.acceleratorBatch, 160),
    pageTitle: sanitizedText(object.pageTitle, 500),
    publishedDate: isoTimestamp(object.publishedDate),
    strategies: arrayValue(object.strategies)
      .map((item) => enumValue(item, EXPORTER_EXTRACTION_STRATEGIES))
      .filter((item): item is ExporterExtractionStrategy => item !== null),
    expectedMinimumCompanies: positiveInteger(object.expectedMinimumCompanies),
    expectedApproximateCompanies: positiveInteger(
      object.expectedApproximateCompanies,
    ),
    warnings: warningArray(object.warnings),
  };
}

function serializeExtraction(value: unknown): SafeCachedExtraction | null {
  const object = recordValue(value);
  const source = serializeValidatedSource(object?.source);
  if (!object || !source) return null;
  return {
    source,
    participants: arrayValue(object.participants)
      .map(serializeParticipant)
      .filter((item): item is SafeCachedParticipant => item !== null)
      .slice(0, 2_000),
    warnings: warningArray(object.warnings),
  };
}

function serializeParticipant(value: unknown): SafeCachedParticipant | null {
  const object = recordValue(value);
  const companyName = sanitizedText(object?.companyName, 160);
  const sourceUrl = safeHttpsUrl(object?.sourceUrl);
  const extractionStrategy = enumValue(
    object?.extractionStrategy,
    EXPORTER_EXTRACTION_STRATEGIES,
  );
  if (!object || !companyName || !sourceUrl || !extractionStrategy) return null;
  const listedCountryEvidence = enumValue(object.listedCountryEvidence, [
    "company_specific",
    "ambiguous",
  ] as const);
  return {
    companyName,
    website: safeHttpsUrl(object.website),
    normalizedDomain: sanitizedHostname(object.normalizedDomain),
    listedCountry: sanitizedText(object.listedCountry, 120),
    listedCountryEvidence,
    industry: sanitizedText(object.industry, 200),
    description: sanitizedText(object.description, 1_000),
    founders: arrayValue(object.founders)
      .map((founderValue) => {
        const founder = recordValue(founderValue);
        const founderName = sanitizedText(founder?.founderName, 200);
        const founderSourceUrl = safeHttpsUrl(founder?.sourceUrl);
        if (!founder || !founderName || !founderSourceUrl) return null;
        return {
          founderName,
          founderRole: sanitizedText(founder.founderRole, 120),
          linkedinUrl: safeHttpsUrl(founder.linkedinUrl),
          sourceUrl: founderSourceUrl,
          confidence: boundedConfidence(founder.confidence),
        };
      })
      .filter((founder): founder is SafeCachedParticipant["founders"][number] =>
        Boolean(founder),
      )
      .slice(0, 20),
    sourceUrl,
    extractionStrategy,
    warnings: warningArray(object.warnings),
  };
}

function deserializeValidatedSource(
  source: SafeCachedValidatedSource,
): ValidatedExporterSource {
  return {
    ...source,
    participantAssertions: [],
  };
}

function warningArray(value: unknown) {
  return [...new Set(
    arrayValue(value)
      .map((item) => sanitizedText(item, 500))
      .filter((item): item is string => Boolean(item)),
  )].slice(0, 100);
}

function sanitizedText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/<[^>]{0,500}>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(
      /(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maximumLength) : null;
}

function safeHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizedHostname(value: unknown) {
  if (typeof value !== "string") return null;
  const hostname = value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    hostname,
  )
    ? hostname
    : null;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function boundedConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function finiteInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function positiveInteger(value: unknown) {
  const integer = finiteInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

function enumValue<const T>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
