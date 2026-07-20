import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import { normalizeFounderName } from "@/lib/founder-normalization";
import {
  resolveCountry,
  type EligibleRegion,
  type RecognizedCountry,
} from "@/lib/geography";

export const COMPANY_ENRICHMENT_MAX_PAGES = 5;

const FALLBACK_PAGE_PATHS = ["/about", "/team", "/company", "/contact"] as const;
const PAGE_LINK_TEXT = /^(?:about(?: us)?|our story|who we are|team|our team|leadership|founders?|executives?|company|contact(?: us)?)$/i;
const PAGE_PATH_SEGMENT = /^(?:about(?:-us)?|our-story|who-we-are|team|our-team|leadership|founders?|executives?|company|contact(?:-us)?)$/i;
const FOUNDER_ROLE = /\b(?:co[\s-]?founder|founder)\b/i;
const FORMER_FOUNDER = /\b(?:former|ex[\s-]?founder|alumni|retired)\b/i;
const UNCERTAIN_FOUNDER = /\b(?:advisor|mentor|investor|speaker)\b/i;
const LOCATION_MARKER = /\b(?:headquarters|headquartered|hq|based\s+in|located\s+in)\b/i;
const GENERIC_PERSON_HEADINGS = new Set([
  "about us",
  "company",
  "founders",
  "leadership",
  "meet the team",
  "our team",
  "team",
]);

export type CompanyFounderStatus = "confirmed" | "possible" | "former";
export type CompanyLocationStatus =
  | "confirmed"
  | "provisional"
  | "conflicting"
  | "missing";

export type CompanyEnrichmentFetchResult = {
  finalUrl: string;
  html: string;
  contentHash?: string | null;
  fetchedAt?: string;
};

export type CompanyEnrichmentFetcher = (
  url: string,
  context: { companyUrl: string },
) => Promise<CompanyEnrichmentFetchResult>;

export type CompanyFounderSeed = {
  name: string;
  role: string | null;
  linkedinUrl?: string | null;
  sourceUrl: string;
};

export type CompanyEnrichmentInput = {
  companyName: string;
  website: string | null;
  listedCountry?: string | null;
  listedCountryEvidence?: "company_specific" | "ambiguous" | null;
  officialSourceUrl?: string | null;
  sourceFounders?: readonly CompanyFounderSeed[];
};

export type CompanyLocationEvidence = {
  country: RecognizedCountry;
  sourceUrl: string | null;
  snippet: string;
  confidence: number;
  authority: "company_official" | "500_global_official";
  evidenceType: "json_ld_address" | "explicit_location" | "participant_listing";
};

export type EnrichedCompanyFounder = {
  name: string;
  role: string;
  linkedinUrl: string | null;
  activeStatus: CompanyFounderStatus;
  confidence: number;
  sourceUrl: string;
  snippet: string;
};

export type CompanyEnrichmentPage = {
  url: string;
  pageTitle: string | null;
  contentHash: string | null;
  fetchedAt: string | null;
};

export type CompanyEnrichmentFailure = {
  url: string;
  reason: string;
  retryable: boolean;
  retryAt: string | null;
};

export type CompanyEnrichmentResult = {
  companyName: string;
  website: string | null;
  canonicalWebsite: string | null;
  pagesAttempted: string[];
  pages: CompanyEnrichmentPage[];
  failures: CompanyEnrichmentFailure[];
  locationStatus: CompanyLocationStatus;
  headquartersCountry: string | null;
  headquartersIso2: string | null;
  headquartersRegion: EligibleRegion | null;
  locationEvidence: CompanyLocationEvidence[];
  founders: EnrichedCompanyFounder[];
  activeFounders: EnrichedCompanyFounder[];
  warnings: string[];
};

type ExtractedHeadquarters = Omit<
  CompanyLocationEvidence,
  "sourceUrl" | "authority"
>;

type ExtractedFounder = Omit<EnrichedCompanyFounder, "sourceUrl">;

export type StandaloneCompanyPageExtraction = {
  pageTitle: string | null;
  linkedPages: string[];
  headquarters: ExtractedHeadquarters[];
  founders: ExtractedFounder[];
};

export async function enrichStandaloneCompany(
  input: CompanyEnrichmentInput,
  dependencies: { fetchHtml: CompanyEnrichmentFetcher },
): Promise<CompanyEnrichmentResult> {
  const warnings: string[] = [];
  const failures: CompanyEnrichmentFailure[] = [];
  const pages: CompanyEnrichmentPage[] = [];
  const pagesAttempted: string[] = [];
  const locationEvidence: CompanyLocationEvidence[] = [];
  const founderCandidates: EnrichedCompanyFounder[] = sourceFounderCandidates(input);
  const homepage = normalizeCompanyHomepage(input.website);

  if (!homepage) {
    warnings.push("The company website is missing or unusable, so enrichment was not attempted.");
    return finishResult(input, null, pagesAttempted, pages, failures, locationEvidence, founderCandidates, warnings);
  }

  let canonicalHomepage = homepage;
  let canonicalOrigin = new URL(homepage).origin;
  const queue = [homepage];
  const queued = new Set(queue);
  const attempted = new Set<string>();
  let homepagePlanned = false;

  while (queue.length > 0 && pagesAttempted.length < COMPANY_ENRICHMENT_MAX_PAGES) {
    const requestedUrl = queue.shift()!;
    queued.delete(requestedUrl);
    const requestKey = normalizePageUrl(requestedUrl);
    if (!requestKey || attempted.has(requestKey)) continue;
    attempted.add(requestKey);
    pagesAttempted.push(requestKey);

    try {
      const fetched = await dependencies.fetchHtml(requestKey, { companyUrl: canonicalHomepage });
      const finalUrl = normalizePageUrl(fetched.finalUrl);
      if (!finalUrl) throw new Error("The company page returned an invalid final URL.");
      const final = new URL(finalUrl);

      if (pages.length === 0 && pagesAttempted.length === 1) {
        if (!sameCompanyHost(final, new URL(homepage))) {
          throw new Error("The company homepage redirected outside its approved host.");
        }
        canonicalOrigin = final.origin;
        canonicalHomepage = new URL("/", canonicalOrigin).toString();
      } else if (final.origin !== canonicalOrigin) {
        throw new Error("The company page redirected outside the canonical company origin.");
      }

      const extraction = extractStandaloneCompanyPage(
        fetched.html,
        finalUrl,
        canonicalOrigin,
      );
      pages.push({
        url: finalUrl,
        pageTitle: extraction.pageTitle,
        contentHash: fetched.contentHash ?? null,
        fetchedAt: fetched.fetchedAt ?? null,
      });
      for (const headquarters of extraction.headquarters) {
        locationEvidence.push({
          ...headquarters,
          sourceUrl: finalUrl,
          authority: "company_official",
        });
      }
      for (const founder of extraction.founders) {
        founderCandidates.push({ ...founder, sourceUrl: finalUrl });
      }

      if (!homepagePlanned) {
        homepagePlanned = true;
        enqueueCompanyPages(
          queue,
          queued,
          attempted,
          extraction.linkedPages,
          canonicalOrigin,
        );
      }
    } catch (error) {
      const failure = classifyFetchFailure(error);
      failures.push({
        url: requestKey,
        reason: sanitizeFailure(error),
        retryable: failure.retryable,
        retryAt: failure.retryAt,
      });
      if (failure.retryAt) {
        warnings.push(
          "Company enrichment was paused because the site requested a Retry-After delay.",
        );
        break;
      }
      if (!homepagePlanned) {
        homepagePlanned = true;
        enqueueCompanyPages(queue, queued, attempted, [], canonicalOrigin);
      }
    }
  }

  if (pages.length === 0) {
    warnings.push("The company site could not be fetched; headquarters and founder data are incomplete.");
  } else if (failures.length > 0) {
    warnings.push("One or more company-owned enrichment pages could not be fetched.");
  }

  return finishResult(
    input,
    canonicalHomepage,
    pagesAttempted,
    pages,
    failures,
    locationEvidence,
    founderCandidates,
    warnings,
  );
}

export const enrichCompany = enrichStandaloneCompany;

export function extractStandaloneCompanyPage(
  html: string,
  pageUrl: string,
  companyOrigin: string,
): StandaloneCompanyPageExtraction {
  const $ = load(html);
  const headquarters = extractJsonLdHeadquarters($);
  const founders = extractJsonLdFounders($, pageUrl);
  $("script, style, noscript, template, svg").remove();
  headquarters.push(...extractVisibleHeadquarters($));
  founders.push(...extractVisibleFounders($, pageUrl));

  return {
    pageTitle:
      cleanText(
        $("meta[property='og:title']").attr("content") ?? $("title").first().text(),
      ).slice(0, 500) || null,
    linkedPages: extractCompanyPageLinks($, pageUrl, companyOrigin),
    headquarters: dedupeHeadquarters(headquarters),
    founders: dedupePageFounders(founders),
  };
}

export const extractCompanyPage = extractStandaloneCompanyPage;

function finishResult(
  input: CompanyEnrichmentInput,
  canonicalWebsite: string | null,
  pagesAttempted: string[],
  pages: CompanyEnrichmentPage[],
  failures: CompanyEnrichmentFailure[],
  companyLocationEvidence: CompanyLocationEvidence[],
  founderCandidates: EnrichedCompanyFounder[],
  warnings: string[],
): CompanyEnrichmentResult {
  const rosterCountry =
    input.listedCountry && input.listedCountryEvidence === "company_specific"
      ? resolveCountry(input.listedCountry)
      : null;
  const locationEvidence = dedupeLocationEvidence([
    ...companyLocationEvidence,
    ...(rosterCountry
      ? [
          {
            country: rosterCountry,
            sourceUrl: input.officialSourceUrl ?? null,
            snippet: `The official participant listing gives ${rosterCountry.canonicalName} as the company location.`,
            confidence: 0.72,
            authority: "500_global_official" as const,
            evidenceType: "participant_listing" as const,
          },
        ]
      : []),
  ]);
  const location = resolveHeadquarters(locationEvidence);
  const founderResolution = resolveFounders(founderCandidates);
  warnings.push(...founderResolution.warnings);

  if (location.status === "missing") {
    warnings.push("Headquarters/current location could not be confirmed.");
  } else if (location.status === "provisional") {
    warnings.push("Only provisional official-roster location evidence is available.");
  } else if (location.status === "conflicting") {
    warnings.push("Headquarters/current-location evidence conflicts across sources.");
  }
  if (founderResolution.active.length === 0) {
    warnings.push("No evidence-backed active founder was confirmed.");
  }

  return {
    companyName: input.companyName,
    website: input.website,
    canonicalWebsite,
    pagesAttempted: [...pagesAttempted],
    pages: [...pages],
    failures: [...failures],
    locationStatus: location.status,
    headquartersCountry: location.country?.canonicalName ?? null,
    headquartersIso2: location.country?.iso2 ?? null,
    headquartersRegion: location.country?.region ?? null,
    locationEvidence,
    founders: founderResolution.all,
    activeFounders: founderResolution.active,
    warnings: [...new Set(warnings)],
  };
}

function sourceFounderCandidates(input: CompanyEnrichmentInput) {
  const founders: EnrichedCompanyFounder[] = [];
  for (const founder of input.sourceFounders ?? []) {
    const role = cleanText(founder.role ?? "");
    if (!role || !isFounderRole(role) || !looksLikePersonName(founder.name)) continue;
    founders.push({
      name: cleanText(founder.name).slice(0, 200),
      role: role.slice(0, 120),
      linkedinUrl: normalizeLinkedInUrl(founder.linkedinUrl, founder.sourceUrl),
      activeStatus: founderStatus(role),
      confidence: 0.76,
      sourceUrl: founder.sourceUrl,
      snippet: cleanText(`${founder.name} — ${role}`).slice(0, 500),
    });
  }
  return founders;
}

function resolveHeadquarters(
  evidence: CompanyLocationEvidence[],
): { status: CompanyLocationStatus; country: RecognizedCountry | null } {
  const companyCountries = new Map<string, RecognizedCountry>();
  const rosterCountries = new Map<string, RecognizedCountry>();
  for (const item of evidence) {
    const target =
      item.authority === "company_official" ? companyCountries : rosterCountries;
    target.set(item.country.iso2, item.country);
  }

  if (companyCountries.size > 1) {
    return { status: "conflicting" as const, country: null };
  }
  const companyCountry = [...companyCountries.values()][0] ?? null;
  if (companyCountry) {
    if (
      rosterCountries.size > 0 &&
      !rosterCountries.has(companyCountry.iso2)
    ) {
      return { status: "conflicting" as const, country: null };
    }
    return { status: "confirmed" as const, country: companyCountry };
  }
  if (rosterCountries.size === 1) {
    return {
      status: "confirmed" as const,
      country: [...rosterCountries.values()][0] ?? null,
    };
  }
  if (rosterCountries.size > 1) {
    return { status: "conflicting" as const, country: null };
  }
  return { status: "missing" as const, country: null };
}

function resolveFounders(founders: EnrichedCompanyFounder[]) {
  const grouped = new Map<string, EnrichedCompanyFounder[]>();
  for (const founder of founders) {
    const normalized = normalizeFounderName(founder.name)?.normalizedFounderName;
    if (!normalized) continue;
    const existing = grouped.get(normalized) ?? [];
    existing.push(founder);
    grouped.set(normalized, existing);
  }

  const all: EnrichedCompanyFounder[] = [];
  const warnings: string[] = [];
  for (const values of grouped.values()) {
    values.sort((left, right) => right.confidence - left.confidence);
    const statuses = new Set(values.map((value) => value.activeStatus));
    const strongest = values[0];
    const conflictingStatus = statuses.has("confirmed") && statuses.has("former");
    const activeStatus: CompanyFounderStatus =
      conflictingStatus || statuses.has("possible")
        ? "possible"
        : statuses.has("confirmed")
          ? "confirmed"
          : "former";
    if (conflictingStatus) {
      warnings.push(`Active-status evidence conflicts for founder ${strongest.name}.`);
    }
    const linkedin = values.find((value) => value.linkedinUrl)?.linkedinUrl ?? null;
    all.push({ ...strongest, activeStatus, linkedinUrl: linkedin });
  }
  all.sort(
    (left, right) =>
      statusRank(right.activeStatus) - statusRank(left.activeStatus) ||
      right.confidence - left.confidence ||
      left.name.localeCompare(right.name),
  );
  const confirmed = all.filter((founder) => founder.activeStatus === "confirmed");
  if (confirmed.length > 4) {
    warnings.push(
      `More than four active founders were found; the four strongest records were selected for upload.`,
    );
  }
  return { all, active: confirmed.slice(0, 4), warnings };
}

function enqueueCompanyPages(
  queue: string[],
  queued: Set<string>,
  attempted: Set<string>,
  actualLinks: readonly string[],
  canonicalOrigin: string,
) {
  const candidates = [
    ...actualLinks,
    ...FALLBACK_PAGE_PATHS.map((path) => new URL(path, canonicalOrigin).toString()),
  ];
  for (const candidate of candidates) {
    if (queue.length + attempted.size >= COMPANY_ENRICHMENT_MAX_PAGES) break;
    const normalized = normalizePageUrl(candidate);
    if (
      !normalized ||
      new URL(normalized).origin !== canonicalOrigin ||
      queued.has(normalized) ||
      attempted.has(normalized)
    ) {
      continue;
    }
    queue.push(normalized);
    queued.add(normalized);
  }
}

function normalizeCompanyHomepage(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    url.protocol = "https:";
    url.port = "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizePageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    url.port = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sameCompanyHost(left: URL, right: URL) {
  return hostKey(left) === hostKey(right);
}

function hostKey(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function extractJsonLdHeadquarters($: CheerioAPI) {
  const results: ExtractedHeadquarters[] = [];
  for (const value of jsonLdValues($)) {
    visitJson(value, (node) => {
      const types = stringArray(node["@type"]);
      if (!types.some((type) => /organization|corporation|business/i.test(type))) return;
      for (const address of [
        ...arrayValue(node.address),
        ...arrayValue(node.legalAddress),
        ...arrayValue(node.location),
        ...arrayValue(node.foundingLocation),
      ]) {
        const object = objectValue(address);
        const rawCountry =
          stringValue(address) ??
          stringValue(object?.addressCountry) ??
          stringValue(objectValue(object?.addressCountry)?.name) ??
          stringValue(object?.name);
        const country = rawCountry ? resolveCountry(rawCountry) : null;
        if (!country) continue;
        results.push({
          country,
          snippet: `Organization JSON-LD lists address country as ${country.canonicalName}.`,
          confidence: 0.96,
          evidenceType: "json_ld_address",
        });
      }
    });
  }
  return results;
}

function extractJsonLdFounders($: CheerioAPI, pageUrl: string) {
  const results: ExtractedFounder[] = [];
  for (const value of jsonLdValues($)) {
    visitJson(value, (node) => {
      const types = stringArray(node["@type"]);
      if (types.some((type) => /organization|corporation|business/i.test(type))) {
        for (const founderValue of [
          ...arrayValue(node.founder),
          ...arrayValue(node.founders),
        ]) {
          const founder = objectValue(founderValue);
          const name = stringValue(founder?.name) ?? stringValue(founderValue);
          const role = stringValue(founder?.jobTitle) ?? "Founder";
          if (!name || !looksLikePersonName(name) || !isFounderRole(role)) continue;
          const linkedin = stringArray(founder?.sameAs)
            .map((candidate) => normalizeLinkedInUrl(candidate, pageUrl))
            .find(Boolean) ?? null;
          results.push({
            name: cleanText(name).slice(0, 200),
            role: cleanText(role).slice(0, 120),
            linkedinUrl: linkedin,
            activeStatus: founderStatus(role),
            confidence: 0.95,
            snippet: cleanText(`${name} — ${role}`).slice(0, 500),
          });
        }
      }
      if (!types.some((type) => /person/i.test(type))) return;
      const name = stringValue(node.name);
      const role = stringValue(node.jobTitle);
      if (!name || !role || !looksLikePersonName(name) || !isFounderRole(role)) return;
      const linkedin = stringArray(node.sameAs)
        .map((candidate) => normalizeLinkedInUrl(candidate, pageUrl))
        .find(Boolean) ?? null;
      results.push({
        name: cleanText(name).slice(0, 200),
        role: cleanText(role).slice(0, 120),
        linkedinUrl: linkedin,
        activeStatus: founderStatus(role),
        confidence: 0.94,
        snippet: cleanText(`${name} — ${role}`).slice(0, 500),
      });
    });
  }
  return results;
}

function extractVisibleHeadquarters($: CheerioAPI) {
  const results: ExtractedHeadquarters[] = [];
  $("address, p, li, section, div").each((_, element) => {
    const text = cleanText($(element).text());
    if (!text || text.length > 500 || !LOCATION_MARKER.test(text)) return;
    const phrase = locationPhrase(text);
    for (const country of countriesFromText(phrase)) {
      results.push({
        country,
        snippet: text.slice(0, 500),
        confidence: /\b(?:headquarters|headquartered|hq)\b/i.test(text) ? 0.93 : 0.88,
        evidenceType: "explicit_location",
      });
    }
  });
  return results;
}

function extractVisibleFounders($: CheerioAPI, pageUrl: string) {
  const results: ExtractedFounder[] = [];
  const containers = $("article, li, section, div, [itemtype$='/Person']")
    .toArray()
    .filter((element) => {
      const text = elementText($, element);
      return text.length >= 3 && text.length <= 800 && isFounderRole(text);
    });

  for (const element of containers) {
    const container = $(element);
    const hasMoreSpecificContainer = containers.some(
      (candidate) => candidate !== element && container.find(candidate).length > 0,
    );
    if (hasMoreSpecificContainer) continue;
    const text = elementText($, element);
    const role = container
      .find("[data-role], .role, p, span, small, h1, h2, h3, h4, h5")
      .toArray()
      .map((item) => cleanText($(item).text()))
      .filter((item) => item.length <= 180 && isFounderRole(item))
      .sort((left, right) => left.length - right.length)[0] ?? text;
    const headingName = container
      .find("[itemprop='name'], [data-name], .name, h1, h2, h3, h4, h5, strong")
      .toArray()
      .map((item) => cleanText($(item).text()))
      .find(looksLikePersonName);
    const inline = !headingName ? inlineFounder(text) : null;
    const name = headingName ?? inline?.name ?? null;
    const resolvedRole = inline?.role ?? role;
    if (!name || !isFounderRole(resolvedRole)) continue;
    const linkedinHref = container
      .find("a[href]")
      .toArray()
      .map((anchor) => $(anchor).attr("href"))
      .map((href) => normalizeLinkedInUrl(href, pageUrl))
      .find(Boolean) ?? null;
    results.push({
      name: name.slice(0, 200),
      role: resolvedRole.slice(0, 120),
      linkedinUrl: linkedinHref,
      activeStatus: founderStatus(`${resolvedRole} ${text}`),
      confidence: 0.9,
      snippet: text.slice(0, 500),
    });
  }
  return results;
}

function extractCompanyPageLinks(
  $: CheerioAPI,
  pageUrl: string,
  companyOrigin: string,
) {
  const links: string[] = [];
  $("a[href]").each((_, element) => {
    try {
      const url = new URL($(element).attr("href") ?? "", pageUrl);
      if (url.protocol !== "https:" || url.origin !== companyOrigin) return;
      const text = cleanText($(element).text());
      const segments = url.pathname.split("/").filter(Boolean);
      const lastSegment = segments.at(-1) ?? "";
      if (!PAGE_PATH_SEGMENT.test(lastSegment) && !PAGE_LINK_TEXT.test(text)) return;
      url.hash = "";
      url.search = "";
      const normalized = url.toString();
      if (!links.includes(normalized)) links.push(normalized);
    } catch {
      // Malformed links are ignored.
    }
  });
  return links.slice(0, COMPANY_ENRICHMENT_MAX_PAGES - 1);
}

function locationPhrase(text: string) {
  const match = LOCATION_MARKER.exec(text);
  if (!match) return "";
  return text
    .slice((match.index ?? 0) + match[0].length)
    .split(/(?:[;|.]|\bwith\s+(?:offices?|teams?)\b|\bserv(?:es|ing)\b)/i, 1)[0]
    .slice(0, 240);
}

function countriesFromText(text: string) {
  const words = cleanText(text.replace(/[()]/g, " "))
    .split(/[\s,/:—–-]+/)
    .filter(Boolean);
  const matches = new Map<string, RecognizedCountry>();
  for (let start = 0; start < words.length; start += 1) {
    for (let length = Math.min(6, words.length - start); length >= 1; length -= 1) {
      const candidate = words.slice(start, start + length).join(" ");
      if (candidate.length === 2 && candidate.toUpperCase() !== "UK") continue;
      if (candidate.toLowerCase() === "georgia") continue;
      const country = resolveCountry(candidate);
      if (country) matches.set(country.iso2, country);
    }
  }
  return [...matches.values()];
}

function inlineFounder(text: string) {
  const nameFirst = text.match(
    /^(.{2,100}?)\s*(?:—|–|\||,)\s*(.{2,180}\bfounder\b.{0,80})$/i,
  );
  if (nameFirst) {
    const name = cleanText(nameFirst[1]);
    const role = cleanText(nameFirst[2]);
    if (looksLikePersonName(name)) return { name, role };
  }
  const roleFirst = text.match(
    /^(.{0,120}\bfounder\b.{0,80}?)\s*(?:—|–|\||:)\s*(.{2,100})$/i,
  );
  if (!roleFirst) return null;
  const role = cleanText(roleFirst[1]);
  const name = cleanText(roleFirst[2]);
  return looksLikePersonName(name) ? { name, role } : null;
}

function looksLikePersonName(value: string) {
  const name = cleanText(value);
  if (!name || name.length > 120 || GENERIC_PERSON_HEADINGS.has(name.toLowerCase())) return false;
  if (/\b(?:founder|chief|officer|ceo|cto|advisor|speaker|team|company|about)\b/i.test(name)) return false;
  const words = name.split(/\s+/);
  return words.length >= 2 && words.length <= 6 && Boolean(normalizeFounderName(name));
}

function isFounderRole(value: string) {
  return FOUNDER_ROLE.test(value);
}

function founderStatus(value: string): CompanyFounderStatus {
  if (FORMER_FOUNDER.test(value)) return "former";
  if (UNCERTAIN_FOUNDER.test(value)) return "possible";
  return "confirmed";
}

function normalizeLinkedInUrl(value: unknown, baseUrl: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      hostname !== "linkedin.com" ||
      !/^\/in\/[^/]+\/?$/i.test(url.pathname)
    ) {
      return null;
    }
    url.hostname = "www.linkedin.com";
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeHeadquarters(values: ExtractedHeadquarters[]) {
  const byKey = new Map<string, ExtractedHeadquarters>();
  for (const value of values) {
    const key = `${value.country.iso2}\u0000${value.evidenceType}`;
    const current = byKey.get(key);
    if (!current || value.confidence > current.confidence) byKey.set(key, value);
  }
  return [...byKey.values()];
}

function dedupeLocationEvidence(values: CompanyLocationEvidence[]) {
  const byKey = new Map<string, CompanyLocationEvidence>();
  for (const value of values) {
    const key = `${value.authority}\u0000${value.country.iso2}\u0000${value.sourceUrl ?? ""}\u0000${value.evidenceType}`;
    const current = byKey.get(key);
    if (!current || value.confidence > current.confidence) byKey.set(key, value);
  }
  return [...byKey.values()].sort((left, right) => right.confidence - left.confidence);
}

function dedupePageFounders(values: ExtractedFounder[]) {
  const byName = new Map<string, ExtractedFounder>();
  for (const value of values) {
    const key = normalizeFounderName(value.name)?.normalizedFounderName;
    if (!key) continue;
    const current = byName.get(key);
    if (!current || value.confidence > current.confidence) byName.set(key, value);
  }
  return [...byName.values()];
}

function statusRank(status: CompanyFounderStatus) {
  return status === "confirmed" ? 3 : status === "possible" ? 2 : 1;
}

function jsonLdValues($: CheerioAPI) {
  const values: unknown[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      values.push(JSON.parse($(element).text()));
    } catch {
      // Malformed JSON-LD must not make enrichment fail.
    }
  });
  return values;
}

function visitJson(value: unknown, visitor: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  visitor(object);
  for (const nested of Object.values(object)) visitJson(nested, visitor);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function elementText($: CheerioAPI, element: AnyNode) {
  const clone = $(element).clone();
  clone.find("*").each((_, child) => {
    $(child).before(" ");
  });
  return cleanText(clone.text());
}

function sanitizeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "The company page could not be fetched.";
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .trim()
    .slice(0, 240);
}

function classifyFetchFailure(error: unknown) {
  const value = error as { kind?: unknown; retryAt?: unknown };
  const kind = typeof value?.kind === "string" ? value.kind : null;
  const retryAt =
    typeof value?.retryAt === "string" &&
    Number.isFinite(Date.parse(value.retryAt))
      ? new Date(value.retryAt).toISOString()
      : null;
  return {
    retryable: kind === "retry" || kind === "error",
    retryAt: kind === "retry" ? retryAt : null,
  };
}
