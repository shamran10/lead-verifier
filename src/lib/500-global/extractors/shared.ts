import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  ExporterExtractionStrategy,
  ExtractedExporterFounder,
  ExtractedExporterParticipant,
} from "@/lib/500-global/exporter-types";
import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";

const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
] as const;

const GENERIC_COMPANY_NAMES = new Set([
  "apply",
  "apply now",
  "company",
  "company name",
  "company logo",
  "coming soon",
  "learn more",
  "logo",
  "industry",
  "placeholder",
  "portfolio",
  "read more",
  "startup",
  "tbd",
  "visit site",
  "website",
]);

const EXCLUDED_ROLE_WORDS =
  /\b(?:advisors?|investors?|judges?|mentors?|service\s+providers?|speakers?|sponsors?)\b/i;
const NEGATIVE_FOUNDER_WORDS =
  /\b(?:advisor|alumni|employee|ex[\s-]?founder|former|investor|mentor|speaker)\b/i;

export type ExtractorDocument = {
  $: CheerioAPI;
  sourceUrl: string;
  sourceHostname: string;
};

export type BoundedSection = {
  marker: Cheerio<AnyNode>;
  container: Cheerio<AnyNode>;
  markerText: string;
};

export function createExtractorDocument(
  html: string,
  sourceUrl: string,
): ExtractorDocument {
  const $ = load(html);
  $("script, style, noscript, template, svg").remove();
  return {
    $,
    sourceUrl,
    sourceHostname: new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ""),
  };
}

export function cleanText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function directText($: CheerioAPI, element: AnyNode) {
  return cleanText(
    $(element)
      .contents()
      .filter((_, node) => node.type === "text")
      .text(),
  );
}

export function normalizeCompanyNameKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 200);
}

export function isExplicitParticipantAssertion(value: string) {
  const text = cleanText(value);
  if (!text || EXCLUDED_ROLE_WORDS.test(text)) return false;
  const hasSubject =
    /\b(?:companies|company|participants?|startups?|ventures?)\b/i.test(text);
  const hasAssertion =
    /\b(?:announc(?:e|es|ed|ing)|cohort|graduates?|graduating|lineup|meet|participants?|presenting|selected|selection|showcas(?:e|ing)|spotlights?|startups?\s+(?:are|include)|companies\s+(?:are|include)|welcomes?)\b/i.test(
      text,
    );
  const scopedRosterHeading =
    /^(?:meet|introducing|presenting)?\s*(?:the\s+)?(?:500\s+global\s+)?(?:[\w-]+\s+){0,5}(?:batch\s*\d+|\d{4}\s+cohort|cohort\s+\d{4})(?:\s+(?:companies|startups|ventures|participants))?\s*:?$/i.test(
      text,
    );
  return (hasSubject && hasAssertion) || scopedRosterHeading;
}

export function isSimpleParticipantHeading(value: string) {
  return /^(?:the\s+)?(?:cohort|companies|participants|startups|ventures)\s*:?$/i.test(
    cleanText(value),
  );
}

export function isExcludedRoleContainer(
  $: CheerioAPI,
  element: AnyNode,
) {
  const semanticSection = $(element).closest("section, article").first();
  const semanticHeading = cleanText(
    semanticSection.find("h1, h2, h3, h4, h5, h6").first().text(),
  );
  if (semanticHeading && isExplicitParticipantAssertion(semanticHeading)) {
    return false;
  }
  const closest = $(element).closest(
    "nav, header, footer, aside, [class*='speaker'], [id*='speaker'], [class*='sponsor'], [id*='sponsor'], [class*='mentor'], [id*='mentor'], [class*='judge'], [id*='judge'], [class*='investor'], [id*='investor'], [class*='service-provider'], [id*='service-provider']",
  );
  if (closest.length) return true;

  if (!semanticSection.length) return false;
  return Boolean(semanticHeading && EXCLUDED_ROLE_WORDS.test(semanticHeading));
}

export function isPlaceholderEntry($: CheerioAPI, element: AnyNode) {
  const target = $(element);
  const classAndId = `${target.attr("class") ?? ""} ${target.attr("id") ?? ""}`;
  const text = cleanText(target.text());
  return (
    /\b(?:placeholder|coming-soon|empty-card|apply-card)\b/i.test(classAndId) ||
    /^(?:coming soon|tbd|apply(?: now)?|your company here|company name|industry)$/i.test(text) ||
    /company\s*name.*company\s*summary\s*goes\s*here/i.test(text) ||
    /\b(?:company\s*summary|description)\s*goes\s*here\b/i.test(text)
  );
}

export function findMarkerElements(document: ExtractorDocument) {
  const { $ } = document;
  return $("h1, h2, h3, h4, h5, h6, p, strong")
    .toArray()
    .filter((element) => {
      if (isExcludedRoleContainer($, element)) return false;
      const value = directText($, element) || cleanText($(element).text());
      return (
        value.length > 0 &&
        value.length <= 400 &&
        (isExplicitParticipantAssertion(value) || isSimpleParticipantHeading(value))
      );
    });
}

export function nearestBoundedContainer(
  document: ExtractorDocument,
  markerElement: AnyNode,
  candidateSelector: string,
) {
  const { $ } = document;
  const marker = $(markerElement);
  const semantic = marker.closest("section, article").first();
  if (
    semantic.length &&
    semantic.find(candidateSelector).length > 0 &&
    !isExcludedRoleContainer($, semantic.get(0)!)
  ) {
    return semantic;
  }

  let sibling = marker.closest("h1, h2, h3, h4, h5, h6, p").first().next();
  if (!sibling.length) sibling = marker.next();
  for (let distance = 0; sibling.length && distance < 5; distance += 1) {
    if (sibling.is("nav, header, footer, aside")) break;
    if (
      (sibling.is(candidateSelector) || sibling.find(candidateSelector).length > 0) &&
      !isExcludedRoleContainer($, sibling.get(0)!)
    ) {
      return sibling;
    }
    const next = sibling.next();
    sibling = next;
  }
  return $([]);
}

export function makeBoundedSection(
  document: ExtractorDocument,
  markerElement: AnyNode,
  container: Cheerio<AnyNode>,
): BoundedSection {
  const { $ } = document;
  return {
    marker: $(markerElement),
    container,
    markerText: cleanText($(markerElement).text()).slice(0, 400),
  };
}

export function extractParticipantFromEntry(
  document: ExtractorDocument,
  entry: Cheerio<AnyNode>,
  strategy: ExporterExtractionStrategy,
  options: { accessibleNameOnly?: boolean } = {},
): ExtractedExporterParticipant | null {
  const { $, sourceUrl, sourceHostname } = document;
  const element = entry.get(0);
  if (!element || isExcludedRoleContainer($, element) || isPlaceholderEntry($, element)) {
    return null;
  }

  const links = entry.find("a[href]").addBack("a[href]").toArray();
  const externalCompanyLinks = links
    .map((link) => publicCompanyLink($, link, sourceUrl, sourceHostname))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const primaryLink = externalCompanyLinks[0] ?? null;

  const companyName = chooseCompanyName($, entry, primaryLink?.element ?? null, {
    accessibleNameOnly: options.accessibleNameOnly === true,
  });
  if (!companyName) return null;

  const normalizedDomain = primaryLink
    ? normalizeDomain(primaryLink.url.toString())
    : null;
  const website = normalizedDomain
    ? canonicalCompanyWebsite(primaryLink!.url)
    : null;
  const text = cleanText(entry.text()).slice(0, 1500);
  const fields = extractDescriptiveFields($, entry, companyName, text);
  const founders = extractFounders($, entry, sourceUrl);
  const warnings: string[] = [];
  if (!website) warnings.push("No usable public company website was listed.");

  return {
    companyName,
    website,
    normalizedDomain,
    listedCountry: fields.listedCountry,
    listedCountryEvidence: fields.listedCountryEvidence,
    industry: fields.industry,
    description: fields.description,
    founders,
    sourceUrl,
    extractionStrategy: strategy,
    evidenceSnippet: text.slice(0, 500),
    warnings,
  };
}

function publicCompanyLink(
  $: CheerioAPI,
  element: AnyNode,
  sourceUrl: string,
  sourceHostname: string,
) {
  const href = $(element).attr("href") ?? "";
  try {
    const url = new URL(href, sourceUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      hostname === sourceHostname ||
      isSocialHostname(hostname)
    ) {
      return null;
    }
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.hash = "";
    return { element, url };
  } catch {
    return null;
  }
}

function canonicalCompanyWebsite(url: URL) {
  const canonical = new URL(url);
  canonical.protocol = "https:";
  canonical.username = "";
  canonical.password = "";
  canonical.hash = "";
  return canonical.toString();
}

function chooseCompanyName(
  $: CheerioAPI,
  entry: Cheerio<AnyNode>,
  primaryLink: AnyNode | null,
  options: { accessibleNameOnly: boolean },
) {
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    const cleaned = cleanText(value ?? "")
      .replace(/\s+(?:official\s+)?(?:website|site)$/i, "")
      .trim();
    if (cleaned) candidates.push(cleaned);
  };

  if (!options.accessibleNameOnly) {
    push(entry.find("[data-company-name]").first().attr("data-company-name"));
    push(entry.find("[data-company-name]").first().text());
    const heading = entry.find("h1, h2, h3, h4, h5, h6, strong").first();
    const headingNode = heading.get(0);
    push(headingNode ? directText($, headingNode) || heading.text() : "");
    if (primaryLink) push($(primaryLink).text());
  }

  for (const anchor of entry.find("a[href]").addBack("a[href]").toArray()) {
    push($(anchor).attr("aria-label"));
    push($(anchor).attr("title"));
    push($(anchor).find("img[alt]").first().attr("alt"));
    if (!options.accessibleNameOnly) push($(anchor).text());
  }

  if (!options.accessibleNameOnly) {
    const firstSegment = cleanText(entry.text()).split(/\s*[|\u2013\u2014]\s*/, 1)[0];
    push(firstSegment);
  }

  return (
    candidates.find((candidate) => {
      const lowered = candidate.toLowerCase();
      return (
        candidate.length >= 2 &&
        candidate.length <= 160 &&
        !/^company\s*name\b/i.test(candidate) &&
        !GENERIC_COMPANY_NAMES.has(lowered) &&
        !EXCLUDED_ROLE_WORDS.test(candidate) &&
        Boolean(normalizeCompanyNameKey(candidate))
      );
    }) ?? null
  );
}

function extractDescriptiveFields(
  $: CheerioAPI,
  entry: Cheerio<AnyNode>,
  companyName: string,
  text: string,
) {
  const explicitCountry = cleanText(
    entry.attr("data-country") ??
      entry.find("[data-country]").first().attr("data-country") ??
      entry.find(".country, [class*='country']").first().text(),
  );
  const genericLocation = cleanText(
    entry.find(".location, [class*='location']").first().text(),
  );
  const dataIndustry = cleanText(
    entry.attr("data-industry") ??
      entry.find("[data-industry]").first().attr("data-industry") ??
      entry.find(".industry, [class*='industry']").first().text(),
  );
  const dataDescription = cleanText(
    entry.attr("data-description") ??
      entry.find("[data-description]").first().attr("data-description") ??
      entry.find(".description, [class*='description']").first().text(),
  );

  const countryLabel =
    text.match(
      /\b(?:country|headquarters|hq|location)\s*:\s*([^|\u2022\u2013\u2014;]{2,100})/i,
    )?.[1] ??
    text.match(/\bbased\s+in\s+([^|\u2022\u2013\u2014;]{2,100})/i)?.[1];
  const industryLabel = text.match(/\bindustry\s*:?\s*([^|\u2022\u2013\u2014;]{2,100})/i)?.[1];
  const pipeFields = text.split("|").map(cleanText).filter(Boolean);
  let listedCountry = explicitCountry || genericLocation || cleanText(countryLabel ?? "") || null;
  let listedCountryEvidence: "company_specific" | "ambiguous" | null =
    explicitCountry || /\b(?:headquarters|hq)\b/i.test(text)
      ? "company_specific"
      : listedCountry
        ? "ambiguous"
        : null;
  let industry = dataIndustry || cleanText(industryLabel ?? "") || null;
  let description = dataDescription || null;

  if (pipeFields.length >= 2 && !industry) industry = pipeFields[1] || null;
  if (pipeFields.length >= 3) {
    const locationAndDescription = pipeFields.slice(2).join(" | ");
    const [location, ...descriptionParts] = locationAndDescription
      .split(/\s+[\u2013\u2014-]\s+/)
      .map(cleanText);
    if (!listedCountry) {
      listedCountry = location || null;
      if (listedCountry) listedCountryEvidence = "company_specific";
    }
    if (!description) description = descriptionParts.join(" - ") || null;
  }

  if (!description) {
    const paragraph = entry
      .find("p")
      .toArray()
      .map((element) => cleanText($(element).text()))
      .find(
        (value) =>
          value.length >= 20 &&
          value.length <= 600 &&
          !/^\s*(?:country|industry|location|headquarters|hq)\s*:/i.test(value),
      );
    description = paragraph ?? null;
  }

  if (description) {
    description = cleanText(description.replace(companyName, "")).slice(0, 1000) || null;
  }
  return {
    listedCountry: listedCountry ? cleanText(listedCountry).slice(0, 120) : null,
    listedCountryEvidence,
    industry: industry ? cleanText(industry).slice(0, 200) : null,
    description,
  };
}

function extractFounders(
  $: CheerioAPI,
  entry: Cheerio<AnyNode>,
  sourceUrl: string,
) {
  const founders: ExtractedExporterFounder[] = [];
  const containers = entry
    .find("[data-founder], .founder, [class*='founder']")
    .toArray();

  for (const element of containers) {
    const container = $(element);
    const text = cleanText(container.text());
    const declaredRole = cleanText(
      container.attr("data-role") ??
        container.find("[data-role], .role, [class*='role']").first().text(),
    );
    const roleEvidence = `${declaredRole} ${text}`;
    if (
      !/\b(?:co[\s-]?founder|founder)\b/i.test(roleEvidence) ||
      NEGATIVE_FOUNDER_WORDS.test(roleEvidence)
    ) {
      continue;
    }
    const name = cleanText(
      container.attr("data-founder") ??
        container.find("h1, h2, h3, h4, h5, strong, [data-name]").first().text(),
    );
    if (!name || !normalizeFounderName(name)) continue;
    const role = declaredRole || text;
    const linkedinUrl = normalizeLinkedInUrl(
      container.find("a[href*='linkedin.com']").first().attr("href"),
      sourceUrl,
    );
    founders.push({
      founderName: name.slice(0, 200),
      founderRole: role.slice(0, 120) || null,
      linkedinUrl,
      sourceUrl,
      confidence: 0.82,
    });
  }

  const byName = new Map<string, ExtractedExporterFounder>();
  for (const founder of founders) {
    const key = normalizeFounderName(founder.founderName)?.normalizedFounderName;
    if (key && !byName.has(key)) byName.set(key, founder);
  }
  return [...byName.values()];
}

function normalizeLinkedInUrl(value: string | undefined, baseUrl: string) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      hostname !== "linkedin.com" ||
      !url.pathname.startsWith("/in/")
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isSocialHostname(hostname: string) {
  return SOCIAL_HOSTS.some(
    (candidate) =>
      hostname === candidate || hostname.endsWith(`.${candidate}`),
  );
}
