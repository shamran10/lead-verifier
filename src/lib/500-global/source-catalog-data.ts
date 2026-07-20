import type { DiscoverySourceKind } from "@/lib/500-global/types";
import type { EligibleRegion } from "@/lib/geography";

export type OfficialDiscoverySource = {
  url: string;
  sourceKind: DiscoverySourceKind;
  acceleratorBatch: string;
  acceleratorYear: 2025 | 2026;
  supportedRegions: readonly EligibleRegion[];
  note: string;
  extractorStrategy: DiscoveryExtractorStrategy;
  expectedMinimumCompanies: number;
  expectedApproximateCompanies?: number;
};

export type DiscoveryExtractorStrategy =
  | "participant_list"
  | "company_cards"
  | "spotlight_sections"
  | "demo_day_sections"
  | "accessible_logo_links"
  | "known_json_ld"
  | "known_embedded_json";

// Only pages that explicitly enumerate participating companies belong here.
// General program, application, and location pages are intentionally excluded.
export const OFFICIAL_DISCOVERY_SOURCES: readonly OfficialDiscoverySource[] = [
  {
    url: "https://500.co/content/creators-ventures-2025",
    sourceKind: "announcement",
    acceleratorBatch: "Creators Ventures Accelerator",
    acceleratorYear: 2026,
    supportedRegions: ["europe", "north_america"],
    note: "Official 500 Global announcement with an explicit participant list.",
    extractorStrategy: "participant_list",
    expectedMinimumCompanies: 1,
    expectedApproximateCompanies: 21,
  },
] as const;

export function selectOfficialDiscoverySources(
  targetYears: readonly number[],
  targetRegions: readonly string[],
) {
  return OFFICIAL_DISCOVERY_SOURCES.filter(
    (source) =>
      targetYears.includes(source.acceleratorYear) &&
      source.supportedRegions.some((region) => targetRegions.includes(region)),
  );
}

export function getOfficialDiscoverySource(url: string) {
  return OFFICIAL_DISCOVERY_SOURCES.find((source) => source.url === url) ?? null;
}

export function getCatalogCoverageWarnings(targetYears: readonly number[]) {
  const availableYears = new Set(
    OFFICIAL_DISCOVERY_SOURCES.map((source) => source.acceleratorYear),
  );
  return [...new Set(targetYears)]
    .filter((year) => !availableYears.has(year as 2025 | 2026))
    .map(
      (year) =>
        `No verified official participant-list source is currently catalogued for ${year}. No unverified URL will be used.`,
    );
}
