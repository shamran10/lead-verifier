import { load } from "cheerio";

import type {
  ExporterExtractionStrategy,
  ExporterSourceKind,
  ExporterYear,
  SourceCandidate,
} from "@/lib/masschallenge/exporter-types";
import { OFFICIAL_MASSCHALLENGE_SOURCES } from "@/lib/masschallenge/source-catalog-data";
import { normalizeDiscoverySourceUrl } from "@/lib/500-global/source-policy-core";
import { mapWithConcurrency } from "@/lib/500-global/rate-limiter";

const SOURCE_TERMS = /\b(class|cohort|batch|accelerator|challenge|finalists?|winners?|demo[ -]?day|startups?|companies|participants?|presenting|selected|graduating)\b/i;
const REJECTED_TERMS = /\b(apply|application|privacy|careers?|speakers?|sponsors?|mentors?|investors?)\b/i;
const OFFICIAL_INDEX_URLS = [
  "https://masschallenge.org/news/",
  ...Array.from(
    { length: 10 },
    (_, index) => `https://masschallenge.org/news/page/${index + 2}/`,
  ),
  "https://masschallenge.org/articles/",
  "https://masschallenge.org/programs-all/",
  "https://masschallenge.org/regions/",
] as const;

// External partner hosts must be reviewed and added here deliberately. An
// empty list is safer than accepting a host through CLI input or environment.
export const APPROVED_EXPORTER_PARTNER_HOSTS: readonly string[] = [];

export const MAINTAINED_EXPORTER_SOURCES: readonly SourceCandidate[] = [
  ...OFFICIAL_MASSCHALLENGE_SOURCES,
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
    candidates: [...candidates.values()]
      .sort((left, right) => candidatePriority(left) - candidatePriority(right))
      .slice(0, 100),
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
      if (/\b20\d{2}\b/.test(context) && !yearHint) return;
      if (!yearHint && !/demo[ -]?day|class|cohort|batch/i.test(context)) return;
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
      let successfulQueries = 0;
      const queryResults = await mapWithConcurrency(
        queries,
        async (query) => {
          const candidates: SourceCandidate[] = [];
          try {
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
            if (!response.ok) return candidates;
            successfulQueries += 1;
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
                const yearHint = yearFromText(context, [2025, 2026]);
                if (/\b20\d{2}\b/.test(context) && !yearHint) continue;
                candidates.push({
                  url: normalized.normalizedUrl,
                  origin: "search_provider",
                  sourceKindHint: inferSourceKind(context),
                  acceleratorYearHint: yearHint,
                  acceleratorBatchHint: result.title?.slice(0, 160) ?? null,
                  strategyHints: inferStrategies(context),
                });
              } catch {
                // Search results remain untrusted until URL and page validation pass.
              }
            }
          } catch {
            // One unavailable query must not discard candidates from successful queries.
          }
          return candidates;
        },
        2,
      );
      if (!successfulQueries) throw new Error("All Brave Search queries failed.");
      return dedupeCandidates(queryResults.flat());
    },
  };
}

function addCandidate(target: Map<string, SourceCandidate>, candidate: SourceCandidate) {
  try {
    const normalized = normalizeDiscoverySourceUrl(candidate.url).normalizedUrl;
    const urlYears = [...normalized.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
    if (urlYears.length && !urlYears.some((year) => year === 2025 || year === 2026)) {
      return;
    }
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

export function buildSourceSearchQueries(years: readonly ExporterYear[]) {
  return years.flatMap((year) => [
    `site:masschallenge.org "${year} cohort" MassChallenge`,
    `site:masschallenge.org "${year} class" MassChallenge`,
    `site:masschallenge.org "${year} companies" MassChallenge accelerator`,
    `site:masschallenge.org "${year} accelerator" (cohort OR class OR companies)`,
    `site:masschallenge.org/news ${year} ("meet the" OR "announces" OR "welcoming") (cohort OR finalists OR startups)`,
    `site:masschallenge.org/articles ${year} (selected OR cohort OR finalists) startups`,
    `site:masschallenge.org ${year} (FinTech OR HealthTech OR Climate OR DeepTech) (cohort OR finalists OR participants)`,
    `site:masschallenge.org ${year} ("Air Force" OR defense OR security OR space) (cohort OR selected OR finalists)`,
    `site:masschallenge.org ${year} (NYC OR London OR Boston OR Switzerland OR UK OR Mexico OR Israel) (cohort OR finalists OR companies)`,
    `site:masschallenge.org ${year} "challenge" (selected startups OR finalists OR participants)`,
  ]);
}

function inferSourceKind(value: string): ExporterSourceKind {
  if (/demo[ -]?day/i.test(value)) return "demo_day";
  if (/cohort|roster|\bclass\b/i.test(value)) return "cohort_roster";
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

function isOfficialHost(hostname: string) {
  return hostname === "masschallenge.org" || hostname.endsWith(".masschallenge.org");
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

function candidatePriority(candidate: SourceCandidate) {
  const originRank = {
    catalog: 0,
    manual: 1,
    search_provider: 2,
    official_index: 3,
    verified_source_link: 4,
  }[candidate.origin ?? "official_index"];
  return (candidate.acceleratorYearHint ? 0 : 10) + originRank;
}
