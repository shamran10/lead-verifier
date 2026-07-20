export const DISCOVERY_RUN_STATUSES = [
  "draft",
  "queued",
  "running",
  "paused",
  "review_ready",
  "importing",
  "completed",
  "completed_with_errors",
  "cancelled",
] as const;
export type DiscoveryRunStatus = (typeof DISCOVERY_RUN_STATUSES)[number];

export const DISCOVERY_SOURCE_KINDS = [
  "cohort_roster",
  "program_page",
  "announcement",
  "demo_day",
  "partner_program",
  "manual",
] as const;
export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];

export type DiscoverySourceApprovalStatus =
  | "pending"
  | "approved"
  | "rejected";
export type DiscoverySourceProcessingStatus =
  | "pending"
  | "processing"
  | "processed"
  | "needs_review"
  | "error"
  | "skipped";
export type DiscoveryEligibilityStatus =
  | "pending"
  | "eligible"
  | "ineligible"
  | "needs_review";
export type DiscoveryReviewStatus = "pending" | "approved" | "rejected";
export type DiscoveryImportStatus =
  | "not_ready"
  | "ready"
  | "imported"
  | "duplicate"
  | "error";
export type DiscoveryEnrichmentStatus =
  | "pending"
  | "processing"
  | "enriched"
  | "needs_review"
  | "error"
  | "skipped";
export type DiscoveryFounderActiveStatus =
  | "confirmed"
  | "possible"
  | "former"
  | "unknown";
export type DiscoveryFounderDuplicateStatus =
  | "unchecked"
  | "new"
  | "existing_yc"
  | "existing_500_global"
  | "same_run";
export type DiscoveryEventLevel = "info" | "warning" | "error";

export const DISCOVERY_EVIDENCE_AUTHORITIES = [
  "500_global_official",
  "company_official",
] as const;
export type DiscoveryEvidenceAuthority =
  (typeof DISCOVERY_EVIDENCE_AUTHORITIES)[number];

export const DISCOVERY_EVIDENCE_TYPES = [
  "official_membership",
  "accelerator_year",
  "accelerator_batch",
  "company_website",
  "headquarters",
  "founder_identity",
  "founder_role",
  "linkedin_url",
] as const;
export type DiscoveryEvidenceType =
  (typeof DISCOVERY_EVIDENCE_TYPES)[number];

export function isDiscoveryEvidenceAuthority(
  value: unknown,
): value is DiscoveryEvidenceAuthority {
  return DISCOVERY_EVIDENCE_AUTHORITIES.includes(
    value as DiscoveryEvidenceAuthority,
  );
}

export function isDiscoveryEvidenceType(
  value: unknown,
): value is DiscoveryEvidenceType {
  return DISCOVERY_EVIDENCE_TYPES.includes(value as DiscoveryEvidenceType);
}

export const DISCOVERY_REVIEW_FILTERS = [
  "action_required",
  "all",
  "eligible",
  "needs_review",
  "ineligible",
  "approved",
  "rejected",
] as const;
export type DiscoveryReviewFilter =
  (typeof DISCOVERY_REVIEW_FILTERS)[number];

export type DiscoveryRunListItem = {
  id: string;
  name: string;
  status: DiscoveryRunStatus;
  target_years: number[];
  target_regions: string[];
  max_records: number;
  dry_run: boolean;
  total_sources: number;
  processed_sources: number;
  discovered_companies: number;
  eligible_companies: number;
  review_companies: number;
  approved_companies: number;
  rejected_companies: number;
  imported_founders: number;
  imported_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscoverySourceListItem = {
  id: string;
  url: string;
  normalized_url: string;
  hostname: string;
  source_kind: DiscoverySourceKind;
  approval_status: DiscoverySourceApprovalStatus;
  processing_status: DiscoverySourceProcessingStatus;
  host_approved_by_admin: boolean;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  last_error: string | null;
  created_at: string;
};

export type DiscoveryEventListItem = {
  id: number;
  level: DiscoveryEventLevel;
  event_type: string;
  message: string;
  created_at: string;
};

export type DiscoveryFounderReviewItem = {
  id: string;
  founder_name: string;
  founder_role: string | null;
  linkedin_url: string | null;
  active_status: DiscoveryFounderActiveStatus;
  review_status: DiscoveryReviewStatus;
  duplicate_status: DiscoveryFounderDuplicateStatus;
  import_status: DiscoveryImportStatus;
  include_in_import: boolean;
  warnings: string[];
};

export type DiscoveryCompanyReviewItem = {
  id: string;
  company_name: string;
  website: string | null;
  normalized_domain: string | null;
  headquarters_country: string | null;
  accelerator_region: "europe" | "north_america" | null;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  source_url: string;
  description: string | null;
  industry: string | null;
  eligibility_status: DiscoveryEligibilityStatus;
  review_status: DiscoveryReviewStatus;
  import_status: DiscoveryImportStatus;
  eligibility_reasons: string[];
  warnings: string[];
  founders: DiscoveryFounderReviewItem[];
};

export type DiscoveryReviewPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type DiscoveryFinderProgress = {
  runStatus: DiscoveryRunStatus;
  totalSources: number;
  processedSources: number;
  pendingSources: number;
  discoveredCompanies: number;
  eligibleCompanies: number;
  needsReviewCompanies: number;
  rejectedCompanies: number;
};

export type DiscoveryEnrichmentProgress = {
  totalCompanies: number;
  checkedCompanies: number;
  pendingCompanies: number;
  eligibleCompanies: number;
  needsReviewCompanies: number;
  ineligibleCompanies: number;
  foundersFound: number;
};

export type DiscoveryEnrichmentNextResult = {
  outcome: "processed" | "idle" | "paused" | "complete";
  message: string;
  progress: DiscoveryEnrichmentProgress;
};

export type DiscoverySeedResult = {
  addedSources: number;
  skippedSources: number;
  warnings: string[];
  progress: DiscoveryFinderProgress;
};

export type DiscoveryNextResult = {
  outcome: "processed" | "deferred" | "idle" | "paused" | "complete";
  message: string;
  progress: DiscoveryFinderProgress;
};

export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function discoveryErrorResponse(error: unknown) {
  if (error instanceof DiscoveryError) {
    return Response.json(
      { error: error.status >= 500 ? "Internal server error." : error.message },
      { status: error.status },
    );
  }
  return Response.json({ error: "Internal server error." }, { status: 500 });
}

export function normalizeDiscoveryReviewFilter(
  value: string | string[] | undefined,
): DiscoveryReviewFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return DISCOVERY_REVIEW_FILTERS.includes(
    candidate as DiscoveryReviewFilter,
  )
    ? (candidate as DiscoveryReviewFilter)
    : "action_required";
}
