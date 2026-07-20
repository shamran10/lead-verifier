import type {
  DiscoveryEligibilityStatus,
  DiscoveryEnrichmentStatus,
  DiscoveryEvidenceAuthority,
  DiscoveryEvidenceType,
  DiscoveryEventLevel,
  DiscoveryFounderActiveStatus,
  DiscoveryFounderDuplicateStatus,
  DiscoveryImportStatus,
  DiscoveryReviewStatus,
  DiscoveryRunStatus,
  DiscoverySourceApprovalStatus,
  DiscoverySourceKind,
  DiscoverySourceProcessingStatus,
} from "@/lib/500-global/types";
import type { SourceType } from "@/lib/types";

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type BatchStatus =
  | "uploaded"
  | "parsed"
  | "verifying"
  | "completed"
  | "completed_with_errors";

export type FounderStatus =
  | "pending"
  | "valid"
  | "duplicate_email"
  | "no_valid_email"
  | "error";

export type AttemptVerificationStatus =
  | "processing"
  | "valid"
  | "catch_all"
  | "unknown"
  | "role_based"
  | "disposable"
  | "risky"
  | "spamtrap"
  | "invalid"
  | "disabled"
  | "inbox_full"
  | "unsafe"
  | "malformed"
  | "malformed_response"
  | "provider_error"
  | "timeout"
  | "error";

type BatchRow = {
  id: string;
  batch_name: string;
  source_file_name: string;
  source_type: SourceType;
  discovery_run_id: string | null;
  status: BatchStatus;
  total_companies: number;
  total_founders: number;
  duplicate_founders: number;
  valid_emails: number;
  no_valid_emails: number;
  created_at: string;
  updated_at: string;
};

type FounderRow = {
  id: string;
  batch_id: string;
  source_sheet_name: string | null;
  source_row: number | null;
  company_name: string;
  website: string | null;
  normalized_domain: string;
  yc_batch: string | null;
  accelerator_name: string | null;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  accelerator_region: "europe" | "north_america" | null;
  source_url: string | null;
  industry: string | null;
  description: string | null;
  country: string | null;
  founder_name: string;
  normalized_founder_name: string;
  first_name: string;
  last_name: string | null;
  linkedin_url: string | null;
  first_candidate_email: string;
  last_candidate_email: string | null;
  selected_email: string | null;
  selected_pattern: string | null;
  status: FounderStatus;
  verification_status: AttemptVerificationStatus | "no_valid_email" | null;
  is_safe_to_send: boolean | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
};

type VerificationAttemptRow = {
  id: string;
  founder_id: string;
  candidate_type: string;
  candidate_email: string;
  provider: string;
  verification_status: AttemptVerificationStatus | null;
  is_safe_to_send: boolean | null;
  is_catch_all: boolean | null;
  is_role_based: boolean | null;
  is_disposable: boolean | null;
  raw_result: unknown | null;
  error_message: string | null;
  attempted_at: string;
};

type DiscoveryRunRow = {
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
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type DiscoverySourceRow = {
  id: string;
  run_id: string;
  discovered_from_source_id: string | null;
  url: string;
  normalized_url: string;
  hostname: string;
  source_kind: DiscoverySourceKind;
  approval_status: DiscoverySourceApprovalStatus;
  processing_status: DiscoverySourceProcessingStatus;
  host_approved_by_admin: boolean;
  official_evidence: boolean;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  page_title: string | null;
  published_date: string | null;
  robots_allowed: boolean | null;
  robots_checked_at: string | null;
  http_status: number | null;
  content_type: string | null;
  content_hash: string | null;
  etag: string | null;
  last_modified: string | null;
  response_metadata: Json;
  extracted_payload: Json;
  attempt_count: number;
  next_retry_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  fetched_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type DiscoveryCompanyRow = {
  id: string;
  run_id: string;
  primary_source_id: string;
  duplicate_of_company_id: string | null;
  company_name: string;
  normalized_company_name: string;
  website: string | null;
  normalized_domain: string | null;
  description: string | null;
  industry: string | null;
  headquarters_country: string | null;
  headquarters_iso2: string | null;
  accelerator_name: string;
  accelerator_batch: string | null;
  accelerator_year: number | null;
  accelerator_region: "europe" | "north_america" | null;
  source_url: string;
  eligibility_status: DiscoveryEligibilityStatus;
  review_status: DiscoveryReviewStatus;
  import_status: DiscoveryImportStatus;
  enrichment_status: DiscoveryEnrichmentStatus;
  eligibility_reasons: string[];
  warnings: string[];
  evidence_summary: Json;
  enrichment_attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  imported_batch_id: string | null;
  enriched_at: string | null;
  imported_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type DiscoveryFounderRow = {
  id: string;
  company_id: string;
  founder_name: string;
  normalized_founder_name: string;
  first_name: string;
  last_name: string | null;
  founder_role: string | null;
  linkedin_url: string | null;
  active_status: DiscoveryFounderActiveStatus;
  review_status: DiscoveryReviewStatus;
  duplicate_status: DiscoveryFounderDuplicateStatus;
  import_status: DiscoveryImportStatus;
  include_in_import: boolean;
  existing_fev_founder_id: string | null;
  imported_fev_founder_id: string | null;
  warnings: string[];
  evidence_summary: Json;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
};

type DiscoveryEvidenceRow = {
  id: string;
  run_id: string;
  source_id: string | null;
  company_id: string;
  founder_id: string | null;
  evidence_type: DiscoveryEvidenceType;
  authority: DiscoveryEvidenceAuthority;
  evidence_url: string;
  page_title: string | null;
  snippet: string | null;
  observed_value: string | null;
  normalized_value: string | null;
  supports_claim: boolean;
  confidence: number;
  content_hash: string | null;
  observed_at: string;
  created_at: string;
};

type DiscoveryEventRow = {
  id: number;
  run_id: string;
  source_id: string | null;
  company_id: string | null;
  level: DiscoveryEventLevel;
  event_type: string;
  message: string;
  details: Json;
  created_at: string;
};

type Insertable<T, Optional extends keyof T> = Omit<T, Optional> &
  Partial<Pick<T, Optional>>;

export type Database = {
  public: {
    Tables: {
      fev_batches: {
        Row: BatchRow;
        Insert: Insertable<BatchRow, "id" | "source_type" | "discovery_run_id" | "status" | "total_companies" | "total_founders" | "duplicate_founders" | "valid_emails" | "no_valid_emails" | "created_at" | "updated_at">;
        Update: Partial<BatchRow>;
        Relationships: [
          {
            foreignKeyName: "fev_batches_discovery_run_id_fkey";
            columns: ["discovery_run_id"];
            isOneToOne: true;
            referencedRelation: "fev_500global_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_founders: {
        Row: FounderRow;
        Insert: Insertable<FounderRow, "id" | "source_sheet_name" | "source_row" | "website" | "yc_batch" | "accelerator_name" | "accelerator_batch" | "accelerator_year" | "accelerator_region" | "source_url" | "industry" | "description" | "country" | "last_name" | "linkedin_url" | "last_candidate_email" | "selected_email" | "selected_pattern" | "status" | "verification_status" | "is_safe_to_send" | "exported_at" | "created_at" | "updated_at">;
        Update: Partial<FounderRow>;
        Relationships: [
          {
            foreignKeyName: "fev_founders_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "fev_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_verification_attempts: {
        Row: VerificationAttemptRow;
        Insert: Insertable<VerificationAttemptRow, "id" | "provider" | "verification_status" | "is_safe_to_send" | "is_catch_all" | "is_role_based" | "is_disposable" | "raw_result" | "error_message" | "attempted_at">;
        Update: Partial<VerificationAttemptRow>;
        Relationships: [
          {
            foreignKeyName: "fev_verification_attempts_founder_id_fkey";
            columns: ["founder_id"];
            isOneToOne: false;
            referencedRelation: "fev_founders";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_runs: {
        Row: DiscoveryRunRow;
        Insert: Insertable<DiscoveryRunRow, "id" | "status" | "total_sources" | "processed_sources" | "discovered_companies" | "eligible_companies" | "review_companies" | "approved_companies" | "rejected_companies" | "imported_founders" | "imported_batch_id" | "last_error" | "started_at" | "completed_at" | "created_at" | "updated_at">;
        Update: Partial<DiscoveryRunRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_runs_imported_batch_id_fkey";
            columns: ["imported_batch_id"];
            isOneToOne: false;
            referencedRelation: "fev_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_sources: {
        Row: DiscoverySourceRow;
        Insert: Insertable<DiscoverySourceRow, "id" | "discovered_from_source_id" | "approval_status" | "processing_status" | "host_approved_by_admin" | "official_evidence" | "accelerator_batch" | "accelerator_year" | "page_title" | "published_date" | "robots_allowed" | "robots_checked_at" | "http_status" | "content_type" | "content_hash" | "etag" | "last_modified" | "response_metadata" | "extracted_payload" | "attempt_count" | "next_retry_at" | "lease_token" | "lease_expires_at" | "fetched_at" | "last_error" | "created_at" | "updated_at">;
        Update: Partial<DiscoverySourceRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_sources_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_sources_discovered_from_source_id_fkey";
            columns: ["discovered_from_source_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_discovered_companies: {
        Row: DiscoveryCompanyRow;
        Insert: Insertable<DiscoveryCompanyRow, "id" | "duplicate_of_company_id" | "website" | "normalized_domain" | "description" | "industry" | "headquarters_country" | "headquarters_iso2" | "accelerator_name" | "accelerator_batch" | "accelerator_year" | "accelerator_region" | "eligibility_status" | "review_status" | "import_status" | "enrichment_status" | "eligibility_reasons" | "warnings" | "evidence_summary" | "enrichment_attempts" | "lease_token" | "lease_expires_at" | "imported_batch_id" | "enriched_at" | "imported_at" | "last_error" | "created_at" | "updated_at">;
        Update: Partial<DiscoveryCompanyRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_discovered_companies_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_discovered_companies_primary_source_id_fkey";
            columns: ["primary_source_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_discovered_companies_duplicate_of_company_id_fkey";
            columns: ["duplicate_of_company_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_discovered_companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_discovered_companies_imported_batch_id_fkey";
            columns: ["imported_batch_id"];
            isOneToOne: false;
            referencedRelation: "fev_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_discovered_founders: {
        Row: DiscoveryFounderRow;
        Insert: Insertable<DiscoveryFounderRow, "id" | "last_name" | "founder_role" | "linkedin_url" | "active_status" | "review_status" | "duplicate_status" | "import_status" | "include_in_import" | "existing_fev_founder_id" | "imported_fev_founder_id" | "warnings" | "evidence_summary" | "imported_at" | "created_at" | "updated_at">;
        Update: Partial<DiscoveryFounderRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_discovered_founders_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_discovered_companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_discovered_founders_existing_fev_founder_id_fkey";
            columns: ["existing_fev_founder_id"];
            isOneToOne: false;
            referencedRelation: "fev_founders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_discovered_founders_imported_fev_founder_id_fkey";
            columns: ["imported_fev_founder_id"];
            isOneToOne: false;
            referencedRelation: "fev_founders";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_evidence: {
        Row: DiscoveryEvidenceRow;
        Insert: Insertable<DiscoveryEvidenceRow, "id" | "source_id" | "founder_id" | "page_title" | "snippet" | "observed_value" | "normalized_value" | "supports_claim" | "confidence" | "content_hash" | "observed_at" | "created_at">;
        Update: Partial<DiscoveryEvidenceRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_evidence_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_evidence_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_evidence_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_discovered_companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_evidence_founder_id_fkey";
            columns: ["founder_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_discovered_founders";
            referencedColumns: ["id"];
          },
        ];
      };
      fev_500global_events: {
        Row: DiscoveryEventRow;
        Insert: Insertable<DiscoveryEventRow, "id" | "source_id" | "company_id" | "created_at">;
        Update: Partial<DiscoveryEventRow>;
        Relationships: [
          {
            foreignKeyName: "fev_500global_events_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_events_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fev_500global_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "fev_500global_discovered_companies";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
