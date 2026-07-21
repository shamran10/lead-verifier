import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  AntlerSourceKind,
  AntlerYear,
  ExtractedAntlerCompany,
} from "@/lib/antler/types";
import { normalizeDomain, normalizeFounderName } from "@/lib/founder-normalization";

const MEMBERSHIP_ASSERTION =
  /\b(?:companies?\s+(?:featured|introduced)\s+in|companies?\s+(?:to|that)\s+join|companies?\s+join(?:ed|ing)?\s+(?:the|our)\s+(?:Antler\s+)?(?:U\.?S\.?\s+)?(?:portfolio|cohort)|join(?:ed|ing)?\s+(?:the|our)\s+(?:Antler\s+)?(?:U\.?S\.?\s+)?(?:portfolio|cohort)|added\s+to\s+(?:the|our)\s+(?:Antler\s+)?portfolio|Antler\s+(?:invested\s+in|backed|is\s+backing))\b/i;
const APPLICATION_ONLY =
  /\b(?:applications?\s+(?:are\s+)?open|apply\s+(?:now|today)|application\s+deadline)\b/i;
const NON_COMPANY_LABEL =
  /^(?:founding team|founders?|table of contents|pre-seed|growth-stage|connect with|interested in|antler residency|more insights|build your startup)$/i;

export function extractShowcaseArticle(input: {
  html: string;
  sourceUrl: string;
  year: AntlerYear;
  program: string;
  sourceKind: Extract<AntlerSourceKind, "showcase" | "investment_announcement">;
}) {
  const $ = load(input.html);
  const pageTitle = cleanText(
    $("meta[property='og:title']").attr("content") ?? $("h1").first().text(),
  );
  const pageText = cleanText($("main").first().text() || $("body").text());
  const rejectionReasons: string[] = [];
  if (!/\bAntler\b/i.test(`${pageTitle} ${pageText}`)) {
    rejectionReasons.push("The page does not establish Antler attribution.");
  }
  if (!MEMBERSHIP_ASSERTION.test(pageText)) {
    rejectionReasons.push("The page does not explicitly establish portfolio or investment participation.");
  }
  if (APPLICATION_ONLY.test(pageText) && !MEMBERSHIP_ASSERTION.test(pageText)) {
    rejectionReasons.push("The page is an application or program page, not a funded-company roster.");
  }
  if (!new RegExp(`\\b${input.year}\\b`).test(`${pageTitle} ${pageText}`)) {
    rejectionReasons.push(`The page does not corroborate participation year ${input.year}.`);
  }
  if (rejectionReasons.length) {
    return { pageTitle, companies: [], rejectionReasons };
  }

  const companies = extractCompanyBlocks($, input);
  if (!companies.length) {
    rejectionReasons.push("No bounded company entries were extracted from the official article.");
  }
  return { pageTitle, companies, rejectionReasons };
}

function extractCompanyBlocks(
  $: CheerioAPI,
  input: {
    sourceUrl: string;
    year: AntlerYear;
    program: string;
    sourceKind: "showcase" | "investment_announcement";
  },
) {
  const companies = new Map<string, ExtractedAntlerCompany>();
  const elements = $("main h2, main h3, main h4, main p, article h2, article h3, article h4, article p, .w-richtext h2, .w-richtext h3, .w-richtext h4, .w-richtext p")
    .toArray();

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const text = cleanText($(element).text());
    const candidate = companyLine(text);
    if (!candidate) continue;

    const following: string[] = [];
    for (let offset = index + 1; offset < elements.length && offset <= index + 3; offset += 1) {
      const next = elements[offset];
      const nextText = cleanText($(next).text());
      if (!nextText) continue;
      if (/^H[234]$/i.test(next.tagName) || companyLine(nextText)) break;
      following.push(nextText);
    }
    const founderText = following.find((value) =>
      /^(?:founders?|founding team)\s*:|\bfounded by\b/i.test(value),
    );
    const founders = founderText
      ? parseFounderEvidence(founderText, input.sourceUrl)
      : [];
    const website = companyWebsite($, element, input.sourceUrl);
    const key = normalizeCompanyKey(candidate.name);
    const company: ExtractedAntlerCompany = {
      company_name: candidate.name,
      website,
      normalized_domain: website ? normalizeDomain(website) : null,
      listed_location: null,
      listed_location_evidence: null,
      industry: null,
      description: candidate.description || null,
      founders,
      participation: [
        {
          year: input.year,
          program: input.program,
          source_kind: input.sourceKind,
          source_url: input.sourceUrl,
        },
      ],
      warnings: [
        ...(website ? [] : ["The official article does not expose a usable company website."]),
        ...(founderText && founders.length === 0
          ? ["Founder wording is biographical, first-name-only, or otherwise insufficient for automatic enrichment."]
          : []),
      ],
    };
    const existing = companies.get(key);
    companies.set(key, existing ? mergeArticleCompany(existing, company) : company);
  }
  return [...companies.values()];
}

function companyLine(value: string) {
  const match = value.match(/^([^:]{2,120}):\s*(.{2,600})$/);
  if (!match) return null;
  const name = cleanText(match[1]).replace(/^#+\s*/, "");
  if (
    NON_COMPANY_LABEL.test(name) ||
    /\b(?:portfolio showcase|portfolio companies|founding team|founders?)\b/i.test(name) ||
    !/[A-Za-z]/.test(name)
  ) {
    return null;
  }
  return { name, description: cleanText(match[2]) };
}

function parseFounderEvidence(value: string, sourceUrl: string) {
  const explicitList = value.match(/^founders?\s*:\s*(.+)$/i)?.[1];
  if (!explicitList) return [];
  const prefix = explicitList
    .split(/\b(?:bring|brings|combine|combines|previously|are|is|has|have|built|led|unite|form|blend|together)\b/i, 1)[0]
    .replace(/[—–.].*$/, "")
    .replace(/\([^)]*\)/g, "");
  return prefix
    .split(/,|\band\b|&/i)
    .map((name) => cleanFounderName(name))
    .filter((name): name is string => Boolean(name))
    .map((name) => ({
      founder_name: name,
      founder_role: "Founder",
      linkedin_url: null,
      source_url: sourceUrl,
      confidence: 0.82,
      active_status: "confirmed" as const,
    }));
}

function cleanFounderName(value: string) {
  const name = cleanText(value)
    .replace(/\b(?:Ph\.?D\.?|M\.?D\.?|M\.?B\.?A\.?)\b/gi, "")
    .replace(/^[^A-Za-z]+|[^A-Za-z.'’ -]+$/g, "")
    .trim();
  const tokens = name.split(/\s+/).filter(Boolean);
  if (
    tokens.length < 2 ||
    tokens.length > 6 ||
    tokens.every((token) => token.length <= 2) ||
    !normalizeFounderName(name)
  ) {
    return null;
  }
  return name;
}

function companyWebsite($: CheerioAPI, element: AnyNode, sourceUrl: string) {
  const href = $(element).find("a[href]").first().attr("href") ?? $(element).attr("href");
  if (!href) return null;
  try {
    const url = new URL(href, sourceUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      host === "antler.co" ||
      host.endsWith(".antler.co") ||
      host === "linkedin.com" ||
      host.endsWith(".linkedin.com")
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function mergeArticleCompany(
  left: ExtractedAntlerCompany,
  right: ExtractedAntlerCompany,
) {
  return {
    ...left,
    website: left.website ?? right.website,
    normalized_domain: left.normalized_domain ?? right.normalized_domain,
    description: left.description ?? right.description,
    founders: [...left.founders, ...right.founders],
    warnings: [...new Set([...left.warnings, ...right.warnings])],
  };
}

function normalizeCompanyKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
