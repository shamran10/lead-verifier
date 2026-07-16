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

type Insertable<T, Optional extends keyof T> = Omit<T, Optional> &
  Partial<Pick<T, Optional>>;

export type Database = {
  public: {
    Tables: {
      fev_batches: {
        Row: BatchRow;
        Insert: Insertable<
          BatchRow,
          | "id"
          | "status"
          | "total_companies"
          | "total_founders"
          | "duplicate_founders"
          | "valid_emails"
          | "no_valid_emails"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<BatchRow>;
        Relationships: [];
      };
      fev_founders: {
        Row: FounderRow;
        Insert: Insertable<
          FounderRow,
          | "id"
          | "source_sheet_name"
          | "source_row"
          | "website"
          | "yc_batch"
          | "industry"
          | "description"
          | "country"
          | "last_name"
          | "linkedin_url"
          | "last_candidate_email"
          | "selected_email"
          | "selected_pattern"
          | "status"
          | "verification_status"
          | "is_safe_to_send"
          | "exported_at"
          | "created_at"
          | "updated_at"
        >;
        Update: Partial<FounderRow>;
        Relationships: [];
      };
      fev_verification_attempts: {
        Row: VerificationAttemptRow;
        Insert: Insertable<
          VerificationAttemptRow,
          | "id"
          | "provider"
          | "verification_status"
          | "is_safe_to_send"
          | "is_catch_all"
          | "is_role_based"
          | "is_disposable"
          | "raw_result"
          | "error_message"
          | "attempted_at"
        >;
        Update: Partial<VerificationAttemptRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
