export type FounderStatus = "ready" | "duplicate";

export type ParsedFounder = {
  sourceSheetName: string;
  sourceRow: number;
  companyName: string;
  website: string;
  normalizedDomain: string;
  ycBatch: string | null;
  industry: string | null;
  description: string | null;
  country: string | null;
  founderName: string;
  normalizedFounderName: string;
  firstName: string;
  lastName: string | null;
  founderRole: string | null;
  linkedinUrl: string | null;
  firstCandidateEmail: string;
  lastCandidateEmail: string | null;
};

export type PreviewFounder = ParsedFounder & {
  status: FounderStatus;
};

export type InvalidSourceRow = {
  sourceSheetName: string;
  sourceRow: number;
  reason: string;
};

export type WorkbookParseResult = {
  founders: ParsedFounder[];
  invalidRows: InvalidSourceRow[];
  processedSheets: string[];
  skippedSheets: string[];
};

export type PreviewResult = {
  founders: PreviewFounder[];
  companyCount: number;
  founderCount: number;
  readyCount: number;
  duplicateCount: number;
  invalidRowCount: number;
  invalidRows: InvalidSourceRow[];
  processedSheets: string[];
  skippedSheets: string[];
};

export type ImportResult = {
  batchId: string;
  insertedCount: number;
  duplicateCount: number;
  invalidRowCount: number;
};

export type VerificationErrorSummary = {
  founderId: string;
  candidateEmail: string;
  message: string;
  attemptedAt: string;
};

export type VerificationProgress = {
  batchId: string;
  status: string;
  totalFounders: number;
  processedFounders: number;
  remainingFounders: number;
  validEmails: number;
  duplicateEmailFounders: number;
  noValidEmails: number;
  errorFounders: number;
  attemptCount: number;
  errorAttemptCount: number;
  percentComplete: number;
  errors: VerificationErrorSummary[];
};

export type VerificationStepResult = {
  progress: VerificationProgress;
  outcome:
    | "reserved_and_checked"
    | "founder_reconciled"
    | "busy"
    | "complete";
};
