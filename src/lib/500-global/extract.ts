import "server-only";

import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";

import type { DiscoveryExtractorStrategy } from "@/lib/500-global/source-catalog";
import { normalizeDomain, normalizeFounderName } from "@/lib/founder-normalization";
import {
  isRecognizedCountry,
  resolveCountry,
  resolveEligibleCountry,
  type EligibleCountry,
  type RecognizedCountry,
} from "@/lib/geography";

const PARTICIPANT_WORD = /\b(companies|startups|participants)\b/i;
const STRONG_PARTICIPANT_MARKER = /\b(companies|startups|participants)\b.{0,80}(\bare\b|\binclude\b|:)/i;
const GENERIC_NAMES = new Set(["website", "learn more", "apply", "portfolio", "company"]);
const MARKER_SELECTOR = "p, h1, h2, h3, h4, h5, h6, strong, span";

export type ExtractedFounder = {
  name: string;
  role: string | null;
  linkedinUrl: string | null;
};

export type ExtractedParticipant = {
  companyName: string;
  website: string | null;
  normalizedDomain: string | null;
  industry: string | null;
  countryText: string | null;
  eligibleCountry: EligibleCountry | null;
  resolvedCountry: RecognizedCountry | null;
  recognizedCountry: boolean;
  description: string | null;
  founders: ExtractedFounder[];
  snippet: string;
  warnings: string[];
};

export type ExtractionDiagnostics = {
  marker_found: boolean;
  candidate_blocks: number;
  list_items: number;
  candidate_links: number;
  accepted_companies: number;
  ignored_missing_link: number;
  ignored_empty_name: number;
  ignored_internal_link: number;
  ignored_duplicate: number;
  extractor_strategy: DiscoveryExtractorStrategy;
};

export type ParticipantExtraction = {
  pageTitle: string | null;
  publishedDate: string | null;
  participants: ExtractedParticipant[];
  warnings: string[];
  diagnostics: ExtractionDiagnostics;
};

export type ExtractionOptions = {
  strategy: DiscoveryExtractorStrategy;
  expectedMinimumCompanies?: number;
  expectedApproximateCompanies?: number;
};

export function extractOfficialParticipants(
  html: string,
  sourceUrl: string,
  options: ExtractionOptions = { strategy: "participant_list" },
): ParticipantExtraction {
  const $ = load(html);
  $("script, style, noscript, template, svg").remove();
  const diagnostics = emptyDiagnostics(options.strategy);

  if (options.strategy !== "participant_list") {
    return extractionResult($, [], diagnostics, [
      `Extractor strategy ${options.strategy} is not enabled.`,
    ]);
  }

  const markerAndList = findPreciseParticipantList($);
  diagnostics.marker_found = markerAndList.markerFound;
  if (!markerAndList.list.length) {
    return extractionResult($, [], diagnostics, [
      markerAndList.markerFound
        ? "A participant marker was found, but no closely related company list was found."
        : "No precise participant-list marker was found on the official page.",
    ]);
  }

  const list = markerAndList.list;
  diagnostics.candidate_blocks = 1;
  diagnostics.list_items = list.find("li").length;
  const participants: ExtractedParticipant[] = [];
  const seenDomains = new Set<string>();
  const seenNames = new Set<string>();

  list.find("li").each((_, element) => {
    const item = $(element);
    const snippet = cleanText(item.text()).slice(0, 500);
    const link = findCompanyLink($, item, sourceUrl, diagnostics);
    if (!link) return;
    const companyName = cleanText(link.text);
    if (!companyName || GENERIC_NAMES.has(companyName.toLowerCase())) {
      diagnostics.ignored_empty_name += 1;
      return;
    }
    const normalizedDomain = normalizeDomain(link.url);
    const normalizedName = normalizeCompanyKey(companyName);
    if (
      (normalizedDomain && seenDomains.has(normalizedDomain)) ||
      (normalizedName && seenNames.has(normalizedName))
    ) {
      diagnostics.ignored_duplicate += 1;
      return;
    }
    if (normalizedDomain) seenDomains.add(normalizedDomain);
    if (normalizedName) seenNames.add(normalizedName);

    const fields = snippet.split("|").map(cleanText);
    const industry = fields.length >= 2 ? fields[1] || null : null;
    const locationAndDescription = fields.length >= 3 ? fields.slice(2).join(" | ") : "";
    const [countryText, ...descriptionParts] = locationAndDescription
      .split(/\s+[\u2013\u2014-]\s+/)
      .map(cleanText);
    const warnings: string[] = [];
    if (!normalizedDomain) warnings.push("The listed company website is not usable.");
    if (!countryText) warnings.push("The company location is missing from the participant listing.");
    else if (!isRecognizedCountry(countryText)) warnings.push("The company location could not be classified automatically.");

    participants.push({
      companyName,
      website: normalizedDomain ? link.url : null,
      normalizedDomain,
      industry,
      countryText: countryText || null,
      eligibleCountry: countryText ? resolveEligibleCountry(countryText) : null,
      resolvedCountry: countryText ? resolveCountry(countryText) : null,
      recognizedCountry: countryText ? isRecognizedCountry(countryText) : false,
      description: descriptionParts.join(" - ") || null,
      founders: [],
      snippet,
      warnings,
    });
  });

  diagnostics.accepted_companies = participants.length;
  const founderAssociationWarnings = attachFounderMentions(
    $,
    participants,
    sourceUrl,
  );
  for (const participant of participants) {
    if (!participant.founders.length) {
      participant.warnings.push("No founder was explicitly identified on the official source.");
    }
  }

  const warnings: string[] = [...founderAssociationWarnings];
  if (!participants.length) warnings.push("No valid company entries were found in the verified participant list.");
  if (
    options.expectedMinimumCompanies !== undefined &&
    participants.length < options.expectedMinimumCompanies
  ) {
    warnings.push(
      `The verified source returned fewer than ${options.expectedMinimumCompanies} expected companies.`,
    );
  }
  if (
    options.expectedApproximateCompanies !== undefined &&
    participants.length !== options.expectedApproximateCompanies
  ) {
    warnings.push(
      `The source currently lists ${participants.length} companies; approximately ${options.expectedApproximateCompanies} were expected.`,
    );
  }
  return extractionResult($, participants, diagnostics, warnings);
}

function findPreciseParticipantList($: CheerioAPI) {
  const candidates = $(MARKER_SELECTOR)
    .toArray()
    .map((element) => {
      const ownText = directText(element);
      const tagName = element.type === "tag" ? element.name.toLowerCase() : "";
      return {
        element: $(element),
        ownText,
        score:
          (STRONG_PARTICIPANT_MARKER.test(ownText) ? 100 : 0) +
          (["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName) ? 20 : 0) -
          Math.min(ownText.length, 500) / 100,
      };
    })
    .filter((candidate) =>
      candidate.ownText.length > 0 &&
      candidate.ownText.length <= 350 &&
      PARTICIPANT_WORD.test(candidate.ownText) &&
      (STRONG_PARTICIPANT_MARKER.test(candidate.ownText) ||
        /^(the\s+)?(companies|startups|participants)\s*:?$/i.test(candidate.ownText)) &&
      !candidate.element.closest("nav, footer, header, aside").length &&
      !/\b(sponsors?|speakers?|judges?|mentors?)\b/i.test(candidate.ownText),
    )
    .sort((left, right) => right.score - left.score);

  for (const candidate of candidates) {
    const list = closestRelatedList(candidate.element);
    if (list.length) return { markerFound: true, list };
  }
  return { markerFound: candidates.length > 0, list: $([]) };

  function directText(element: AnyNode) {
    return cleanText(
      $(element)
        .contents()
        .filter((_, node) => node.type === "text")
        .text(),
    );
  }

  function closestRelatedList(marker: Cheerio<AnyNode>) {
    const semanticBlock = marker.closest("p, h1, h2, h3, h4, h5, h6").first();
    const bases = [marker, semanticBlock.length ? semanticBlock : marker.parent().first()];
    for (const base of bases) {
      if (!base.length) continue;
      const nested = base.children("ul, ol").first();
      if (nested.length) return nested;
      let sibling = base.next();
      for (let distance = 0; sibling.length && distance < 4; distance += 1) {
        if (sibling.is("ul, ol")) return sibling;
        const wrapped = sibling.children("ul, ol").first();
        if (wrapped.length) return wrapped;
        if (/^(nav|footer)$/i.test(sibling.get(0)?.tagName ?? "")) break;
        sibling = sibling.next();
      }
    }
    return $([]);
  }
}

function findCompanyLink(
  $: CheerioAPI,
  item: Cheerio<AnyNode>,
  sourceUrl: string,
  diagnostics: ExtractionDiagnostics,
) {
  let sawExternalLink = false;
  for (const element of item.find("a[href]").toArray()) {
    diagnostics.candidate_links += 1;
    const href = $(element).attr("href") ?? "";
    const text = $(element).text();
    try {
      const url = new URL(href, sourceUrl);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (
        !["http:", "https:"].includes(url.protocol) ||
        hostname === "500.co" ||
        hostname.endsWith(".500.co") ||
        isSocialHostname(hostname)
      ) {
        diagnostics.ignored_internal_link += 1;
        continue;
      }
      sawExternalLink = true;
      if (!cleanText(text) || GENERIC_NAMES.has(cleanText(text).toLowerCase())) continue;
      url.hash = "";
      return { text, url: url.toString() };
    } catch {
      diagnostics.ignored_internal_link += 1;
    }
  }
  if (!sawExternalLink) diagnostics.ignored_missing_link += 1;
  else diagnostics.ignored_empty_name += 1;
  return null;
}

function attachFounderMentions(
  $: CheerioAPI,
  participants: ExtractedParticipant[],
  sourceUrl: string,
) {
  const warnings: string[] = [];
  $("a[href*='linkedin.com']").each((_, element) => {
    const anchor = $(element);
    const name = cleanText(anchor.text());
    const normalized = normalizeFounderName(name);
    if (!normalized) return;
    const block = anchor.closest("p, li, div").first();
    const blockText = cleanText(block.text());
    if (!/\bfounder\b/i.test(blockText)) return;
    const company = findNearestFollowingCompany(
      $,
      block,
      element,
      participants,
      sourceUrl,
    );
    if (!company) {
      warnings.push(
        `Founder ${name.slice(0, 120)} could not be associated with a nearby company reference.`,
      );
      return;
    }
    if (company.founders.some((founder) => founder.name === name)) return;
    let linkedinUrl: string | null = null;
    try {
      const url = new URL(anchor.attr("href") ?? "", sourceUrl);
      linkedinUrl = url.protocol === "https:" ? url.toString() : null;
    } catch {
      linkedinUrl = null;
    }
    const companyPosition = blockText.toLowerCase().indexOf(company.companyName.toLowerCase());
    const namePosition = blockText.toLowerCase().indexOf(name.toLowerCase());
    const roleText =
      namePosition >= 0 && companyPosition > namePosition
        ? blockText.slice(namePosition + name.length, companyPosition).replace(/^[,\s]+|\s+(?:of|at)\s*$/gi, "").trim()
        : "";
    company.founders.push({
      name,
      role: roleText.slice(0, 120) || null,
      linkedinUrl,
    });
  });
  return warnings;
}

function findNearestFollowingCompany(
  $: CheerioAPI,
  block: Cheerio<AnyNode>,
  founderElement: Element,
  participants: ExtractedParticipant[],
  sourceUrl: string,
) {
  const links = block.find("a[href]").toArray();
  const founderIndex = links.indexOf(founderElement);
  if (founderIndex < 0) return null;
  for (const link of links.slice(founderIndex + 1)) {
    const anchor = $(link);
    const href = anchor.attr("href") ?? "";
    if (/linkedin\.com/i.test(href)) return null;
    let domain: string | null = null;
    try {
      domain = normalizeDomain(new URL(href, sourceUrl).toString());
    } catch {
      domain = null;
    }
    const linkText = cleanText(anchor.text());
    const normalizedLinkName = normalizeCompanyKey(linkText);
    const company = participants.find(
      (participant) =>
        (domain !== null && participant.normalizedDomain === domain) ||
        (normalizedLinkName.length > 0 &&
          normalizeCompanyKey(participant.companyName) === normalizedLinkName),
    );
    if (company) return company;
  }
  return null;
}

function extractionResult(
  $: CheerioAPI,
  participants: ExtractedParticipant[],
  diagnostics: ExtractionDiagnostics,
  warnings: string[],
): ParticipantExtraction {
  return {
    pageTitle: pageTitle($),
    publishedDate: publishedDate($),
    participants,
    warnings,
    diagnostics,
  };
}

function emptyDiagnostics(strategy: DiscoveryExtractorStrategy): ExtractionDiagnostics {
  return {
    marker_found: false,
    candidate_blocks: 0,
    list_items: 0,
    candidate_links: 0,
    accepted_companies: 0,
    ignored_missing_link: 0,
    ignored_empty_name: 0,
    ignored_internal_link: 0,
    ignored_duplicate: 0,
    extractor_strategy: strategy,
  };
}

function isSocialHostname(hostname: string) {
  return ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function normalizeCompanyKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function pageTitle($: CheerioAPI) {
  const value = cleanText($("meta[property='og:title']").attr("content") ?? $("title").first().text());
  return value ? value.slice(0, 500) : null;
}

function publishedDate($: CheerioAPI) {
  const value = cleanText(
    $("meta[property='article:published_time']").attr("content") ??
      $("time[datetime]").first().attr("datetime") ??
      "",
  );
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
