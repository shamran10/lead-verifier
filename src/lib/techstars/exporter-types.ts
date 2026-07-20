export const EXPORTER_SOURCE_KINDS = [
  "announcement",
  "cohort_roster",
  "demo_day",
  "event_page",
  "regional_program",
  "partner_program",
  "manual_catalog",
] as const;

export type ExporterSourceKind = (typeof EXPORTER_SOURCE_KINDS)[number];

export const EXPORTER_EXTRACTION_STRATEGIES = [
  "participant_list",
  "company_cards",
  "spotlight_sections",
  "demo_day_sections",
  "accessible_logo_links",
  "known_structured_data",
] as const;

export type ExporterExtractionStrategy =
  (typeof EXPORTER_EXTRACTION_STRATEGIES)[number];

export type ExporterYear = 2025 | 2026;
export type ExporterRegion = "europe" | "north_america";

export type SourceDiscoveryOrigin =
  | "catalog"
  | "official_index"
  | "verified_source_link"
  | "search_provider"
  | "manual";

/**
 * An untrusted source candidate. Hints help choose a bounded extractor, but they
 * never bypass host, year, or participant-section validation.
 */
export type SourceCandidate = {
  url: string;
  originalUrl?: string | null;
  origin?: SourceDiscoveryOrigin;
  discoveredFrom?: string | null;
  sourceKindHint?: ExporterSourceKind | null;
  acceleratorYearHint?: number | null;
  acceleratorBatchHint?: string | null;
  strategyHints?: readonly ExporterExtractionStrategy[];
  expectedMinimumCompanies?: number | null;
  expectedApproximateCompanies?: number | null;
};

export type SourceValidationReasonCode =
  | "invalid_url"
  | "unapproved_host"
  | "unsupported_year"
  | "ambiguous_year"
  | "year_conflict"
  | "unsupported_source_kind"
  | "missing_techstars_attribution"
  | "application_only"
  | "general_program_only"
  | "historical_portfolio"
  | "no_participant_assertion"
  | "unbounded_participant_section"
  | "no_extractable_participants"
  | "participant_count_mismatch";

export type ExtractionProbe = {
  strategy: ExporterExtractionStrategy;
  markerFound: boolean;
  boundedSectionCount: number;
  candidateCount: number;
  confidence: number;
  warnings: string[];
};

export type ExtractedExporterFounder = {
  founderName: string;
  founderRole: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  confidence: number;
};

export type ExtractedExporterParticipant = {
  companyName: string;
  website: string | null;
  normalizedDomain: string | null;
  listedCountry: string | null;
  listedCountryEvidence?: "company_specific" | "ambiguous" | null;
  industry: string | null;
  description: string | null;
  founders: ExtractedExporterFounder[];
  sourceUrl: string;
  extractionStrategy: ExporterExtractionStrategy;
  evidenceSnippet: string;
  warnings: string[];
};

export type StrategyExtractionResult = {
  strategy: ExporterExtractionStrategy;
  participants: ExtractedExporterParticipant[];
  probe: ExtractionProbe;
  warnings: string[];
};

export type ValidatedExporterSource = {
  url: string;
  originalUrl: string;
  hostname: string;
  sourceKind: ExporterSourceKind;
  acceleratorYear: ExporterYear;
  acceleratorBatch: string | null;
  pageTitle: string | null;
  publishedDate: string | null;
  strategies: ExporterExtractionStrategy[];
  participantAssertions: string[];
  expectedMinimumCompanies: number | null;
  expectedApproximateCompanies: number | null;
  warnings: string[];
};

export type SourceValidationResult = {
  disposition: "accepted" | "rejected" | "needs_review";
  accepted: boolean;
  source: ValidatedExporterSource | null;
  reasonCodes: SourceValidationReasonCode[];
  warnings: string[];
  probes: ExtractionProbe[];
};

export type ValidatedSourceExtraction = {
  source: ValidatedExporterSource;
  participants: ExtractedExporterParticipant[];
  strategyResults: StrategyExtractionResult[];
  warnings: string[];
};

export type SourceValidationOptions = {
  targetYears?: readonly number[];
  approvedPartnerHosts?: readonly string[];
};
