import type {
  ExporterExtractionStrategy,
  ExporterSourceKind,
  ExporterYear,
  ExtractedExporterParticipant,
  ValidatedExporterSource,
} from "@/lib/masschallenge/exporter-types";
import type { EligibleRegion } from "@/lib/geography";

export type ExportedCompanyFounder = {
  founderName: string;
  founderRole: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  confidence: number;
  activeStatus: "confirmed" | "possible" | "former" | "unknown";
};

export type ExporterCompanyRecord = {
  companyName: string;
  website: string | null;
  normalizedDomain: string | null;
  acceleratorName: "MassChallenge";
  acceleratorBatch: string | null;
  acceleratorYear: ExporterYear;
  sourceUrl: string;
  sourceKind: ExporterSourceKind;
  officialMembershipStatus: "confirmed";
  listedCountry: string | null;
  listedCountryEvidence: "company_specific" | "ambiguous" | null;
  industry: string | null;
  description: string | null;
  founders: ExportedCompanyFounder[];
  supportingSourceUrls: string[];
  programAssociations?: Array<{
    program: string | null;
    year: ExporterYear;
    sourceUrl: string;
    participantStatus: "selected" | "finalist" | "participant" | "winner";
  }>;
  extractionStrategies: ExporterExtractionStrategy[];
  warnings: string[];
  evidenceStrength: number;
};

export type ExporterFinalCompany = ExporterCompanyRecord & {
  headquartersCountry: string | null;
  headquartersIso2: string | null;
  headquartersRegion: EligibleRegion | null;
  locationStatus: "confirmed" | "missing" | "conflicting";
  locationEvidence: string[];
  founderEvidence: string[];
  reviewReasons: string[];
};

export type ValidatedSourceExtraction = {
  source: ValidatedExporterSource;
  participants: ExtractedExporterParticipant[];
  warnings: string[];
};
