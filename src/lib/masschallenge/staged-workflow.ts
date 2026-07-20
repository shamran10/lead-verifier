import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EligibleRegion } from "@/lib/geography";
import type {
  ExporterSourceKind,
  ExporterYear,
} from "@/lib/masschallenge/exporter-types";
import type {
  BlockedSourceExportRow,
  ExcludedExportRow,
  NeedsReviewExportRow,
} from "@/lib/masschallenge/xlsx-export";
import { replaceCacheFileWithRetry } from "@/lib/masschallenge/exporter-cache";

export const MASSCHALLENGE_STAGE_SCHEMA_VERSION = 1 as const;

export type DiscoveredMassChallengeCompany = {
  company_name: string;
  website: string | null;
  normalized_domain: string | null;
  accelerator_batch: string | null;
  accelerator_year: ExporterYear;
  program_name: string | null;
  listed_location: string | null;
  listed_location_evidence: "company_specific" | "ambiguous" | null;
  canonical_country: string | null;
  country_iso2: string | null;
  roster_location_evidence: {
    authority: "masschallenge_official";
    evidence_type: "participant_listing";
    listed_location: string;
    canonical_country: string;
    country_iso2: string;
    region: EligibleRegion | null;
    confidence: number;
    source_url: string;
  } | null;
  industry: string | null;
  description: string | null;
  source_url: string;
  additional_source_urls: string[];
  program_associations: Array<{
    program: string | null;
    year: ExporterYear;
    source_url: string;
    participant_status: "selected" | "finalist" | "participant" | "winner";
  }>;
  source_kind: ExporterSourceKind;
  discovery_status: "official_confirmed";
  discovery_warnings: string[];
};

export type MassChallengeSourceSummary = {
  sources_discovered: number;
  sources_validated: number;
  sources_processed: number;
  official_companies_extracted: number;
  unique_companies: number;
  duplicates_merged: number;
  sources_blocked: number;
  roster_locations_recognized: number;
};

export type DiscoveredMassChallengeDocument = {
  schema_version: typeof MASSCHALLENGE_STAGE_SCHEMA_VERSION;
  stage: "discover";
  generated_at: string;
  years: ExporterYear[];
  companies: DiscoveredMassChallengeCompany[];
  source_summary: MassChallengeSourceSummary;
  blocked_sources: BlockedSourceExportRow[];
  source_warnings: NeedsReviewExportRow[];
  excluded_sources: ExcludedExportRow[];
  duplicate_audit: ExcludedExportRow[];
  coverage_warnings: string[];
};

export type MassChallengeLocationClassification =
  | EligibleRegion
  | "outside_target_region"
  | "unresolved_location"
  | "conflicting_location";

export type FilteredMassChallengeCompany = DiscoveredMassChallengeCompany & {
  location_classification: MassChallengeLocationClassification;
  location_evidence: string[];
  location_warnings: string[];
  company_pages_checked: string[];
  company_site_failures: string[];
};

export type FilteredMassChallengeDocument = {
  schema_version: typeof MASSCHALLENGE_STAGE_SCHEMA_VERSION;
  stage: "filter";
  generated_at: string;
  years: ExporterYear[];
  regions: EligibleRegion[];
  companies: FilteredMassChallengeCompany[];
  blocked_sources: BlockedSourceExportRow[];
  source_warnings: NeedsReviewExportRow[];
  excluded_sources: ExcludedExportRow[];
  duplicate_audit: ExcludedExportRow[];
  coverage_warnings: string[];
};

export function discoveredDatasetPath(root = process.cwd()) {
  return path.resolve(root, ".cache", "masschallenge", "discovered-companies.json");
}

export function filteredDatasetPath(root = process.cwd()) {
  return path.resolve(root, ".cache", "masschallenge", "filtered-companies.json");
}

export async function writeStageDocument(filePath: string, value: unknown) {
  assertSafeDerivedValue(value, "document");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await replaceCacheFileWithRetry(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readDiscoveredDocument(filePath = discoveredDatasetPath()) {
  const value = await readJson(filePath, "Stage 1 discovery output");
  if (
    !isRecord(value) ||
    value.schema_version !== MASSCHALLENGE_STAGE_SCHEMA_VERSION ||
    value.stage !== "discover" ||
    !Array.isArray(value.companies) ||
    !value.companies.every(isDiscoveredCompany)
  ) {
    throw new Error("Stage 1 discovery output has an unsupported or invalid structure. Run lead:masschallenge:discover -- --fresh.");
  }
  return value as DiscoveredMassChallengeDocument;
}

export async function readFilteredDocument(filePath = filteredDatasetPath()) {
  const value = await readJson(filePath, "Stage 2 filter output");
  if (
    !isRecord(value) ||
    value.schema_version !== MASSCHALLENGE_STAGE_SCHEMA_VERSION ||
    value.stage !== "filter" ||
    !Array.isArray(value.companies) ||
    !value.companies.every(isFilteredCompany)
  ) {
    throw new Error("Stage 2 filter output has an unsupported or invalid structure. Run lead:masschallenge:filter -- --fresh.");
  }
  return value as FilteredMassChallengeDocument;
}

function isDiscoveredCompany(value: unknown): value is DiscoveredMassChallengeCompany {
  return Boolean(
    isRecord(value) &&
      typeof value.company_name === "string" && value.company_name.trim() &&
      (value.website === null || typeof value.website === "string") &&
      (value.normalized_domain === null || typeof value.normalized_domain === "string") &&
      (value.accelerator_year === 2025 || value.accelerator_year === 2026) &&
      typeof value.source_url === "string" &&
      value.discovery_status === "official_confirmed" &&
      Array.isArray(value.additional_source_urls) &&
      Array.isArray(value.program_associations) &&
      Array.isArray(value.discovery_warnings),
  );
}

function isFilteredCompany(value: unknown): value is FilteredMassChallengeCompany {
  if (!isDiscoveredCompany(value)) return false;
  const filtered = value as DiscoveredMassChallengeCompany & Record<string, unknown>;
  return (
    ["europe", "north_america", "outside_target_region", "unresolved_location", "conflicting_location"].includes(String(filtered.location_classification)) &&
    Array.isArray(filtered.location_evidence) &&
    Array.isArray(filtered.location_warnings) &&
    Array.isArray(filtered.company_pages_checked) &&
    Array.isArray(filtered.company_site_failures)
  );
}

async function readJson(filePath: string, label: string) {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} is missing at ${filePath}. Run the preceding stage first.`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON. Rerun the preceding stage with --fresh.`);
  }
}

function assertSafeDerivedValue(value: unknown, location: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (/<!doctype\s+html|<html(?:\s|>)/i.test(value)) {
      throw new Error("Raw HTML cannot be stored in MassChallenge stage outputs.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeDerivedValue(entry, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) throw new Error(`Non-JSON value at ${location}.`);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^(?:html|rawhtml|body|rawbody|headers|password|secret|apikey|authorization|cookie|session|token|rawpayload)$/.test(normalized)) {
      throw new Error(`Unsafe field ${location}.${key} cannot be stored.`);
    }
    assertSafeDerivedValue(entry, `${location}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
