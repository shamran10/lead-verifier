import { load } from "cheerio";

import type {
  ExporterExtractionStrategy,
  ExporterSourceKind,
  ExporterYear,
  SourceCandidate,
} from "@/lib/500-global/exporter-types";
import { OFFICIAL_DISCOVERY_SOURCES } from "@/lib/500-global/source-catalog-data";
import { normalizeDiscoverySourceUrl } from "@/lib/500-global/source-policy-core";

const SOURCE_TERMS = /\b(cohort|batch|accelerator|demo[ -]?day|startups?|companies|participants?|presenting|selected|graduating)\b/i;
const REJECTED_TERMS = /\b(apply|application|privacy|careers?|speakers?|sponsors?|mentors?|investors?|portfolio)\b/i;
const OFFICIAL_INDEX_URLS = [
  "https://500.co/content",
  "https://500.co/events",
] as const;

// External partner hosts must be reviewed and added here deliberately. An
// empty list is safer than accepting a host through CLI input or environment.
export const APPROVED_EXPORTER_PARTNER_HOSTS: readonly string[] = [];

export const MAINTAINED_EXPORTER_SOURCES: readonly SourceCandidate[] = [
  ...OFFICIAL_DISCOVERY_SOURCES.map((source) => ({
    url: source.url,
    origin: "catalog" as const,
    sourceKindHint: mapCatalogKind(source.sourceKind),
    acceleratorYearHint: source.acceleratorYear,
    acceleratorBatchHint: source.acceleratorBatch,
    strategyHints: [mapCatalogStrategy(source.extractorStrategy)],
    expectedMinimumCompanies: source.expectedMinimumCompanies,
    expectedApproximateCompanies: source.expectedApproximateCompanies ?? null,
  })),
  {
    url: "https://events.500.co/500b36dd/website",
    origin: "catalog",
    sourceKindHint: "demo_day",
    acceleratorYearHint: 2025,
    acceleratorBatchHint: "Flagship Accelerator Batch 36",
    strategyHints: ["spotlight_sections", "company_cards"],
    expectedMinimumCompanies: 1,
  },
  {
    url: "https://events.500.co/500eurasiab8dd",
    origin: "catalog",
    sourceKindHint: "demo_day",
    acceleratorYearHint: 2025,
    acceleratorBatchHint: "500 Eurasia Batch 8",
    strategyHints: ["spotlight_sections", "demo_day_sections", "company_cards"],
    expectedMinimumCompanies: 6,
    expectedApproximateCompanies: 6,
  },
  {
    url: "https://events.500.co/500eurasiab9dd/website",
    origin: "catalog",
    sourceKindHint: "demo_day",
    acceleratorYearHint: 2025,
    acceleratorBatchHint: "500 Eurasia Batch 9",
    strategyHints: ["demo_day_sections", "company_cards"],
    expectedMinimumCompanies: 1,
    expectedApproximateCompanies: 12,
  },
  {
    url: "https://events.500.co/japanesestartupshowcase/website",
    origin: "catalog",
    sourceKindHint: "partner_program",
    acceleratorYearHint: 2025,
    acceleratorBatchHint: "Japanese Startup Showcase",
    strategyHints: ["spotlight_sections", "company_cards", "accessible_logo_links"],
    expectedMinimumCompanies: 12,
    expectedApproximateCompanies: 12,
  },
  {
    url: "https://events.500.co/500jstarxdd2024",
    origin: "catalog",
    sourceKindHint: "partner_program",
    acceleratorYearHint: 2025,
    acceleratorBatchHint: "J-StarX Silicon Valley Extended Program",
    strategyHints: ["demo_day_sections", "company_cards", "accessible_logo_links"],
    expectedMinimumCompanies: 1,
    expectedApproximateCompanies: 15,
  },
  {
    url: "https://events.500.co/500eurasiabatch10demoday",
    origin: "catalog",
    sourceKindHint: "demo_day",
    acceleratorYearHint: 2026,
    acceleratorBatchHint: "500 Eurasia Batch 10",
    strategyHints: ["demo_day_sections", "company_cards"],
    expectedMinimumCompanies: 1,
  },
] as const;

export type SourceDiscoveryFetchResult = {
  html: string;
  finalUrl: string;
};

export type SourceSearchProvider = {
  readonly id: string;
  isConfigured(): boolean;
  discover(input: {
    years: readonly ExporterYear[];
    queries: readonly string[];
  }): Promise<SourceCandidate[]>;
};

export type SourceDiscoveryResult = {
  candidates: SourceCandidate[];
  indexUrlsAttempted: number;
  indexUrlsFetched: number;
  searchProviderUsed: string | null;
  warnings: string[];
};

export async function discoverOfficialSourceCandidates(options: {
  years: readonly ExporterYear[];
  fetchIndex: (url: string) => Promise<SourceDiscoveryFetchResult>;
  searchProvider?: SourceSearchProvider | null;
  indexUrls?: readonly string[];
}): Promise<SourceDiscoveryResult> {
  const warnings: string[] = [];
  const candidates = new Map<string, SourceCandidate>();
  for (const candidate of MAINTAINED_EXPORTER_SOURCES) {
    if (!candidate.acceleratorYearHint || options.years.includes(candidate.acceleratorYearHint as ExporterYear)) {
      addCandidate(candidates, candidate);
    }
  }

  const indexes = options.indexUrls ?? OFFICIAL_INDEX_URLS;
  let indexUrlsFetched = 0;
  for (const indexUrl of indexes) {
    try {
      const fetched = await options.fetchIndex(indexUrl);
      indexUrlsFetched += 1;
      for (const candidate of extractOfficialIndexCandidates(
        fetched.html,
        fetched.finalUrl,
        options.years,
      )) {
        addCandidate(candidates, candidate);
      }
    } catch {
      warnings.push(`Official source index could not be fetched: ${indexUrl}`);
    }
  }

  let searchProviderUsed: string | null = null;
  const provider = options.searchProvider;
  if (provider?.isConfigured()) {
    try {
      const discovered = await provider.discover({
        years: options.years,
        queries: buildSourceSearchQueries(options.years),
      });
      searchProviderUsed = provider.id;
      for (const candidate of discovered) addCandidate(candidates, candidate);
    } catch {
      warnings.push(`${provider.id} source discovery was unavailable; catalog and official indexes were still used.`);
    }
  } else {
    warnings.push("External source discovery was unavailable; set BRAVE_SEARCH_API_KEY to enable optional API-based discovery.");
  }

  return {
    candidates: [...candidates.values()].slice(0, 100),
    indexUrlsAttempted: indexes.length,
    indexUrlsFetched,
    searchProviderUsed,
    warnings,
  };
}

export function extractOfficialIndexCandidates(
  html: string,
  indexUrl: string,
  years: readonly ExporterYear[],
) {
  const $ = load(html);
  const results: SourceCandidate[] = [];
  $("a[href]").each((_, element) => {
    const anchor = cleanText($(element).text());
    const href = $(element).attr("href") ?? "";
    const context = cleanText(`${anchor} ${href}`);
    if (!SOURCE_TERMS.test(context) || REJECTED_TERMS.test(context)) return;
    try {
      const normalized = normalizeDiscoverySourceUrl(new URL(href, indexUrl).toString());
      if (!isApprovedDiscoveryHost(normalized.hostname)) return;
      const yearHint = yearFromText(context, years);
      if (!yearHint && !/demo[ -]?day|cohort|batch/i.test(context)) return;
      results.push({
        url: normalized.normalizedUrl,
        origin: "official_index",
        discoveredFrom: indexUrl,
        sourceKindHint: inferSourceKind(context),
        acceleratorYearHint: yearHint,
        acceleratorBatchHint: anchor || null,
        strategyHints: inferStrategies(context),
      });
    } catch {
      // Ignore malformed and policy-rejected links.
    }
  });
  return dedupeCandidates(results);
}

export function extractLinkedOfficialSourceCandidates(
  html: string,
  sourceUrl: string,
  years: readonly ExporterYear[],
) {
  return extractOfficialIndexCandidates(html, sourceUrl, years).map((candidate) => ({
    ...candidate,
    origin: "verified_source_link" as const,
    discoveredFrom: sourceUrl,
  }));
}

export function createBraveSourceSearchProvider(
  apiKey = process.env.BRAVE_SEARCH_API_KEY,
): SourceSearchProvider {
  return {
    id: "Brave Search API",
    isConfigured: () => Boolean(apiKey),
    async discover({ queries }) {
      if (!apiKey) return [];
      const candidates: SourceCandidate[] = [];
      for (const query of queries) {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", query);
        url.searchParams.set("count", "20");
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
        const payload = await response.json() as {
          web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
        };
        for (const result of payload.web?.results ?? []) {
          if (!result.url) continue;
          try {
            const normalized = normalizeDiscoverySourceUrl(result.url);
            if (!isApprovedDiscoveryHost(normalized.hostname)) continue;
            const context = cleanText(`${result.title ?? ""} ${result.description ?? ""} ${result.url}`);
            if (!SOURCE_TERMS.test(context) || REJECTED_TERMS.test(context)) continue;
            candidates.push({
              url: normalized.normalizedUrl,
              origin: "search_provider",
              sourceKindHint: inferSourceKind(context),
              acceleratorYearHint: yearFromText(context, [2025, 2026]),
              acceleratorBatchHint: result.title?.slice(0, 160) ?? null,
              strategyHints: inferStrategies(context),
            });
          } catch {
            // Search results remain untrusted until URL and page validation pass.
          }
        }
      }
      return dedupeCandidates(candidates);
    },
  };
}

function addCandidate(target: Map<string, SourceCandidate>, candidate: SourceCandidate) {
  try {
    const normalized = normalizeDiscoverySourceUrl(candidate.url).normalizedUrl;
    if (!target.has(normalized)) target.set(normalized, { ...candidate, url: normalized });
  } catch {
    // Ignore invalid candidate URLs.
  }
}

function dedupeCandidates(candidates: readonly SourceCandidate[]) {
  const result = new Map<string, SourceCandidate>();
  for (const candidate of candidates) addCandidate(result, candidate);
  return [...result.values()];
}

function buildSourceSearchQueries(years: readonly ExporterYear[]) {
  return years.flatMap((year) => [
    `site:500.co/content ${year} (cohort OR companies OR startups) "500 Global"`,
    `site:events.500.co ${year} ("demo day" OR startups OR cohort)`,
  ]);
}

function inferSourceKind(value: string): ExporterSourceKind {
  if (/demo[ -]?day/i.test(value)) return "demo_day";
  if (/cohort|roster/i.test(value)) return "cohort_roster";
  if (/partner|powered by/i.test(value)) return "partner_program";
  if (/regional|eurasia|georgia|japan|korea|mena|latam/i.test(value)) return "regional_program";
  if (/event/i.test(value)) return "event_page";
  return "announcement";
}

function inferStrategies(value: string): ExporterExtractionStrategy[] {
  if (/demo[ -]?day|presenting|pitches/i.test(value)) return ["demo_day_sections", "company_cards"];
  if (/spotlight/i.test(value)) return ["spotlight_sections", "company_cards"];
  if (/companies|startups|participants|cohort/i.test(value)) return ["participant_list", "company_cards"];
  return ["company_cards", "accessible_logo_links"];
}

function yearFromText(value: string, years: readonly ExporterYear[]) {
  const found = years.filter((year) => new RegExp(`\\b${year}\\b`).test(value));
  return found.length === 1 ? found[0] : null;
}

function mapCatalogStrategy(value: string): ExporterExtractionStrategy {
  return value === "known_json_ld" || value === "known_embedded_json"
    ? "known_structured_data"
    : value as ExporterExtractionStrategy;
}

function mapCatalogKind(value: string): ExporterSourceKind {
  if (value === "manual") return "manual_catalog";
  if (value === "program_page") return "regional_program";
  if (value === "cohort_roster" || value === "announcement" || value === "demo_day" || value === "partner_program") {
    return value;
  }
  return "manual_catalog";
}

function isOfficialHost(hostname: string) {
  return hostname === "500.co" || hostname.endsWith(".500.co");
}

function isApprovedDiscoveryHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return (
    isOfficialHost(normalized) ||
    APPROVED_EXPORTER_PARTNER_HOSTS.some(
      (host) => normalized === host || normalized.endsWith(`.${host}`),
    )
  );
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
