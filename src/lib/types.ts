export type FounderStatus = "ready" | "duplicate";

export const SOURCE_TYPES = [
  "yc",
  "500_global",
  "techstars",
  "masschallenge",
  "antler",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_LABELS: Record<SourceType, string> = {
  yc: "YC",
  "500_global": "500 Global",
  techstars: "Techstars",
  masschallenge: "MassChallenge",
  antler: "Antler",
};

export function sourceTypeLabel(sourceType: SourceType) {
  return SOURCE_LABELS[sourceType];
}

export function isAcceleratorSourceType(sourceType: SourceType) {
  return sourceType !== "yc";
}

export function parseSourceType(value: unknown): SourceType | null {
  if (value === null || value === undefined) return "yc";
  return typeof value === "string" && SOURCE_TYPES.includes(value as SourceType)
    ? (value as SourceType)
    : null;
}

export type ParsedFounder = {
  sourceSheetName: string;
  sourceRow: number;
  companyName: string;
  website: string;
  normalizedDomain: string;
  ycBatch: string | null;
  acceleratorName: string | null;
  acceleratorBatch: string | null;
  acceleratorYear: number | null;
  acceleratorRegion: "europe" | "north_america" | null;
  sourceUrl: string | null;
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
  sourceType: SourceType;
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
