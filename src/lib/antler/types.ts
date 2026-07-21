import type {
  CompanyEnrichmentResult,
  CompanyFounderStatus,
} from "@/lib/500-global/company-enrichment";
import type { EligibleRegion } from "@/lib/geography";

export type AntlerYear = 2025 | 2026;
export type AntlerRegion = EligibleRegion;

export type AntlerSourceKind =
  | "portfolio_directory"
  | "showcase"
  | "investment_announcement"
  | "insights_index";

export type AntlerSourceOrigin =
  | "catalog"
  | "portfolio_pagination"
  | "official_index"
  | "search_provider";

export type AntlerSourceCandidate = {
  url: string;
  sourceKind: AntlerSourceKind;
  origin: AntlerSourceOrigin;
  discoveredFrom: string | null;
  yearHint: AntlerYear | null;
  programHint: string | null;
};

export type AntlerParticipation = {
  year: AntlerYear;
  program: string | null;
  source_kind: Exclude<AntlerSourceKind, "insights_index">;
  source_url: string;
};

export type AntlerFounderEvidence = {
  founder_name: string;
  founder_role: string;
  linkedin_url: string | null;
  source_url: string;
  confidence: number;
  active_status: CompanyFounderStatus;
};

export type ExtractedAntlerCompany = {
  company_name: string;
  website: string | null;
  normalized_domain: string | null;
  listed_location: string | null;
  listed_location_evidence: "company_specific" | "ambiguous" | null;
  industry: string | null;
  description: string | null;
  founders: AntlerFounderEvidence[];
  participation: AntlerParticipation[];
  warnings: string[];
};

export type AntlerSourceStatus =
  | "validated"
  | "index_processed"
  | "rejected"
  | "robots_blocked"
  | "retry_wait"
  | "failed";

export type AntlerSourceResult = {
  candidate: AntlerSourceCandidate;
  status: AntlerSourceStatus;
  final_url: string | null;
  page_title: string | null;
  fetched_at: string | null;
  content_hash: string | null;
  companies: ExtractedAntlerCompany[];
  linked_candidates: AntlerSourceCandidate[];
  rejection_reasons: string[];
  warnings: string[];
  error: string | null;
};

export type DiscoveredAntlerCompany = ExtractedAntlerCompany & {
  source_url: string;
  additional_source_urls: string[];
  discovery_status: "official_confirmed";
};

export type BlockedAntlerSource = {
  source_url: string;
  source_title: string;
  accelerator_year: number | string;
  source_kind: string;
  reason: string;
  discovery_origin: string;
  discovered_from: string;
  manual_review_status: string;
};

export type DuplicateAntlerCompany = {
  company_name: string;
  website: string;
  accelerator_year: number | string;
  reason: string;
  source_url: string;
};

export type DiscoveredAntlerDocument = {
  schema_version: 1;
  stage: "discover";
  generated_at: string;
  years: AntlerYear[];
  companies: DiscoveredAntlerCompany[];
  blocked_sources: BlockedAntlerSource[];
  rejected_sources: BlockedAntlerSource[];
  duplicate_audit: DuplicateAntlerCompany[];
  coverage_warnings: string[];
  source_summary: {
    sources_discovered: number;
    sources_validated: number;
    sources_blocked: number;
    official_company_records: number;
    unique_companies: number;
    duplicates_merged: number;
  };
};

export type AntlerLocationClassification =
  | EligibleRegion
  | "outside_target_region"
  | "unresolved_location"
  | "conflicting_location";

export type FilteredAntlerCompany = DiscoveredAntlerCompany & {
  canonical_country: string | null;
  country_iso2: string | null;
  location_classification: AntlerLocationClassification;
  location_evidence: string[];
  location_warnings: string[];
  company_pages_checked: string[];
  company_site_failures: string[];
};

export type FilteredAntlerDocument = {
  schema_version: 1;
  stage: "filter";
  generated_at: string;
  years: AntlerYear[];
  regions: AntlerRegion[];
  companies: FilteredAntlerCompany[];
  blocked_sources: BlockedAntlerSource[];
  rejected_sources: BlockedAntlerSource[];
  duplicate_audit: DuplicateAntlerCompany[];
  coverage_warnings: string[];
};

export type EnrichedAntlerCompany = FilteredAntlerCompany & {
  enrichment: CompanyEnrichmentResult;
};
