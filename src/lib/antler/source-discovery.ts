import { load } from "cheerio";

import { mapWithConcurrency } from "@/lib/500-global/rate-limiter";
import {
  isRobotsDisallowedAntlerPath,
  normalizeAntlerSourceUrl,
} from "@/lib/antler/source-policy";
import type {
  AntlerSourceCandidate,
  AntlerYear,
} from "@/lib/antler/types";

const DISCOVERY_TERMS =
  /\b(?:portfolio|showcase|cohort|residency|invested|investment|backed|companies|startups)\b/i;
const REJECTED_TERMS =
  /\b(?:apply|applications? open|jobs?|careers?|speaker|mentor|staff|partner profile)\b/i;

export async function discoverAntlerSources(input: {
  catalog: readonly AntlerSourceCandidate[];
  years: readonly AntlerYear[];
}) {
  const candidates = new Map<string, AntlerSourceCandidate>();
  for (const candidate of input.catalog) addCandidate(candidates, candidate);
  const warnings: string[] = [];
  const brave = createBraveSearchProvider();
  if (brave) {
    try {
      for (const candidate of await brave(input.years)) {
        addCandidate(candidates, candidate);
      }
    } catch {
      warnings.push("Brave Search was unavailable; maintained and official-index discovery continued.");
    }
  } else {
    warnings.push("BRAVE_SEARCH_API_KEY is not configured; discovery uses maintained and official Antler indexes only.");
  }
  return { candidates: [...candidates.values()], warnings };
}

export function extractOfficialIndexCandidates(
  html: string,
  sourceUrl: string,
  years: readonly AntlerYear[],
) {
  const $ = load(html);
  const candidates: AntlerSourceCandidate[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const context = cleanText(`${$(element).text()} ${$(element).closest("article,li,div").text()}`).slice(0, 800);
    if (!DISCOVERY_TERMS.test(context) || REJECTED_TERMS.test(context)) return;
    let url: string;
    try {
      url = normalizeAntlerSourceUrl(href, sourceUrl);
    } catch {
      return;
    }
    if (isRobotsDisallowedAntlerPath(url)) return;
    const pathname = new URL(url).pathname;
    if (!/^\/(?:blog|press-releases)\//.test(pathname)) return;
    const year = yearFromText(`${context} ${url}`, years);
    if (!year) return;
    candidates.push({
      url,
      sourceKind: /showcase/i.test(context) ? "showcase" : "investment_announcement",
      origin: "official_index",
      discoveredFrom: sourceUrl,
      yearHint: year,
      programHint: cleanText($(element).text()).slice(0, 160) || null,
    });
  });
  return dedupeCandidates(candidates);
}

export function portfolioPaginationCandidates(
  urls: readonly string[],
  discoveredFrom: string,
) {
  return dedupeCandidates(
    urls.map((url) => ({
      url,
      sourceKind: "portfolio_directory" as const,
      origin: "portfolio_pagination" as const,
      discoveredFrom,
      yearHint: null,
      programHint: "Antler Portfolio Directory",
    })),
  );
}

function createBraveSearchProvider() {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return null;
  return async (years: readonly AntlerYear[]) => {
    const results = await mapWithConcurrency(
      buildAntlerSearchQueries(years),
      async (query) => {
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
          if (!response.ok) return [];
          const payload = (await response.json()) as {
            web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
          };
          const candidates: AntlerSourceCandidate[] = [];
          for (const result of payload.web?.results ?? []) {
            if (!result.url) continue;
            const context = cleanText(`${result.title ?? ""} ${result.description ?? ""} ${result.url}`);
            if (!DISCOVERY_TERMS.test(context) || REJECTED_TERMS.test(context)) continue;
            let normalized: string;
            try {
              normalized = normalizeAntlerSourceUrl(result.url);
            } catch {
              continue;
            }
            if (isRobotsDisallowedAntlerPath(normalized)) continue;
            const pathname = new URL(normalized).pathname;
            if (!/^\/(?:blog|press-releases)\//.test(pathname)) continue;
            const year = yearFromText(context, years);
            if (!year) continue;
            candidates.push({
              url: normalized,
              sourceKind: /showcase/i.test(context) ? "showcase" : "investment_announcement",
              origin: "search_provider",
              discoveredFrom: null,
              yearHint: year,
              programHint: result.title?.slice(0, 160) ?? null,
            });
          }
          return candidates;
        } catch {
          return [];
        }
      },
      2,
    );
    return dedupeCandidates(results.flat());
  };
}

export function buildAntlerSearchQueries(years: readonly AntlerYear[]) {
  return years.flatMap((year) => [
    `site:antler.co/blog ${year} (portfolio OR showcase) companies Antler`,
    `site:antler.co/blog ${year} (invested OR backed) startups Antler`,
    `site:antler.co/press-releases ${year} (portfolio OR invested OR backed) companies`,
  ]);
}

function addCandidate(
  target: Map<string, AntlerSourceCandidate>,
  candidate: AntlerSourceCandidate,
) {
  try {
    const url = normalizeAntlerSourceUrl(candidate.url);
    if (isRobotsDisallowedAntlerPath(url)) return;
    if (!target.has(url)) target.set(url, { ...candidate, url });
  } catch {
    // Untrusted discovery URLs are ignored.
  }
}

function dedupeCandidates(candidates: readonly AntlerSourceCandidate[]) {
  const values = new Map<string, AntlerSourceCandidate>();
  for (const candidate of candidates) addCandidate(values, candidate);
  return [...values.values()];
}

function yearFromText(value: string, years: readonly AntlerYear[]) {
  const matches = years.filter((year) => new RegExp(`\\b${year}\\b`).test(value));
  return matches.length === 1 ? matches[0] : null;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
