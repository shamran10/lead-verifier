import { load } from "cheerio";

import type {
  ExtractedExporterFounder,
  ExtractedExporterParticipant,
  ExtractionProbe,
  StrategyExtractionResult,
} from "@/lib/masschallenge/exporter-types";
import {
  cleanText,
  createExtractorDocument,
  findMarkerElements,
  isExplicitParticipantAssertion,
} from "@/lib/masschallenge/extractors/shared";
import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";
import { resolveCountry } from "@/lib/geography";

const STRATEGY = "known_structured_data" as const;
const MAX_STRUCTURED_SCRIPTS = 20;
const MAX_STRUCTURED_SCRIPT_CHARACTERS = 250_000;

export function probeKnownStructuredData(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const markerFound = findMarkerElements(document).some((marker) =>
    isExplicitParticipantAssertion(document.$(marker).text()),
  );
  const collections = markerFound ? participantCollections(html) : [];
  const candidateCount = collections.reduce(
    (total, collection) => total + collection.length,
    0,
  );
  return {
    strategy: STRATEGY,
    markerFound,
    boundedSectionCount: collections.length,
    candidateCount,
    confidence: markerFound && candidateCount ? 0.93 : 0,
    warnings: markerFound && !candidateCount
      ? ["No supported Organization records were found in a bounded participant ItemList."]
      : [],
  };
}

export function extractKnownStructuredData(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const probe = probeKnownStructuredData(html, sourceUrl);
  const participants = participantCollections(html)
    .flat()
    .map((organization) => participantFromOrganization(organization, sourceUrl))
    .filter((value): value is ExtractedExporterParticipant => value !== null);
  return {
    strategy: STRATEGY,
    participants,
    probe: { ...probe, candidateCount: participants.length },
    warnings: participants.length
      ? []
      : ["The verified structured participant list contained no usable Organization records."],
  };
}

function participantCollections(html: string) {
  const $ = load(html);
  const collections: Record<string, unknown>[][] = [];
  $("script[type='application/ld+json']")
    .slice(0, MAX_STRUCTURED_SCRIPTS)
    .each((_, element) => {
      const raw = $(element).text();
      if (!raw || raw.length > MAX_STRUCTURED_SCRIPT_CHARACTERS) return;
      try {
        visitJson(JSON.parse(raw), (node) => {
          if (
            typeValues(node["@type"]).some((type) => type === "itemlist") &&
            Array.isArray(node.itemListElement)
          ) {
            const organizations = organizationItems(node);
            if (organizations.length) collections.push(organizations);
          }
        });
      } catch {
        // Malformed or unsupported JSON-LD is ignored conservatively.
      }
    });
  $("script[type='application/json'], script#__NEXT_DATA__")
    .slice(0, MAX_STRUCTURED_SCRIPTS)
    .each((_, element) => {
      const raw = $(element).text();
      if (!raw || raw.length > MAX_STRUCTURED_SCRIPT_CHARACTERS) return;
      try {
        visitJsonCollections(JSON.parse(raw), (key, values) => {
          if (!/^(?:cohort|companies|participants|startups|ventures)$/i.test(key)) {
            return;
          }
          const organizations = values
            .slice(0, 500)
            .map((value) => objectValue(value))
            .map((value) => objectValue(value?.company) ?? value)
            .filter((value): value is Record<string, unknown> =>
              Boolean(
                value &&
                (stringValue(value.name) || stringValue(value.companyName)) &&
                (stringValue(value.url) || stringValue(value.website)),
              ),
            );
          if (organizations.length) collections.push(organizations);
        });
      } catch {
        // Malformed or unsupported embedded JSON is ignored conservatively.
      }
    });
  return collections;
}

function organizationItems(list: Record<string, unknown>) {
  const results: Record<string, unknown>[] = [];
  for (const entry of arrayValue(list.itemListElement).slice(0, 500)) {
    const entryObject = objectValue(entry);
    const item = objectValue(entryObject?.item) ?? entryObject;
    if (
      item &&
      typeValues(item["@type"]).some((type) =>
        ["organization", "corporation", "localbusiness"].includes(type),
      )
    ) {
      results.push(item);
    }
  }
  return results;
}

function participantFromOrganization(
  organization: Record<string, unknown>,
  sourceUrl: string,
): ExtractedExporterParticipant | null {
  const companyName = (
    stringValue(organization.name) ?? stringValue(organization.companyName)
  )?.slice(0, 160) ?? null;
  if (!companyName) return null;
  const websiteValue =
    stringValue(organization.url) ?? stringValue(organization.website);
  const normalizedDomain = websiteValue ? normalizeDomain(websiteValue) : null;
  const website = normalizedDomain ? canonicalWebsite(websiteValue!) : null;
  const country = organizationCountry(organization);
  const founders = structuredFounders(organization, sourceUrl);
  return {
    companyName,
    website,
    normalizedDomain,
    listedCountry: country?.canonicalName ?? null,
    listedCountryEvidence: country ? "company_specific" : null,
    industry:
      stringValue(organization.industry)?.slice(0, 200) ?? null,
    description:
      stringValue(organization.description)?.slice(0, 1_000) ?? null,
    founders,
    sourceUrl,
    extractionStrategy: STRATEGY,
    evidenceSnippet: `${companyName} is listed as an Organization in the verified participant ItemList.`,
    warnings: [
      ...(!website ? ["No usable public company website was listed."] : []),
    ],
    participantStatus: "participant",
  };
}

function organizationCountry(organization: Record<string, unknown>) {
  const directCountry =
    stringValue(organization.headquartersCountry) ??
    stringValue(organization.country);
  const resolvedDirect = directCountry ? resolveCountry(directCountry) : null;
  if (resolvedDirect) return resolvedDirect;
  for (const address of arrayValue(organization.address)) {
    const object = objectValue(address);
    const countryValue =
      stringValue(object?.addressCountry) ??
      stringValue(objectValue(object?.addressCountry)?.name);
    const country = countryValue ? resolveCountry(countryValue) : null;
    if (country) return country;
  }
  return null;
}

function visitJsonCollections(
  value: unknown,
  visitor: (key: string, values: unknown[]) => void,
) {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJsonCollections(entry, visitor));
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const [key, nested] of Object.entries(object)) {
    if (Array.isArray(nested)) visitor(key, nested);
    visitJsonCollections(nested, visitor);
  }
}

function structuredFounders(
  organization: Record<string, unknown>,
  sourceUrl: string,
) {
  const results: ExtractedExporterFounder[] = [];
  for (const value of [
    ...arrayValue(organization.founder),
    ...arrayValue(organization.founders),
  ]) {
    const founder = objectValue(value);
    const name = stringValue(founder?.name) ?? stringValue(founder?.founderName);
    const declaredRole =
      stringValue(founder?.jobTitle) ?? stringValue(founder?.role);
    const role = declaredRole && /\bfounder\b/i.test(declaredRole)
      ? declaredRole
      : "Founder";
    if (
      !name ||
      !normalizeFounderName(name) ||
      /\b(?:former|ex[ -]?founder|advisor|mentor|investor|speaker|alumni)\b/i.test(role)
    ) {
      continue;
    }
    const linkedinUrl = arrayValue(founder?.sameAs)
      .map(stringValue)
      .map((url) => normalizeLinkedInUrl(url, sourceUrl))
      .find((url): url is string => Boolean(url)) ?? null;
    results.push({
      founderName: cleanText(name).slice(0, 200),
      founderRole: cleanText(role).slice(0, 120),
      linkedinUrl,
      sourceUrl,
      confidence: 0.9,
    });
  }
  return results;
}

function canonicalWebsite(value: string) {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeLinkedInUrl(value: string | null, sourceUrl: string) {
  if (!value) return null;
  try {
    const url = new URL(value, sourceUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || host !== "linkedin.com" || !/^\/in\//i.test(url.pathname)) {
      return null;
    }
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function visitJson(
  value: unknown,
  visitor: (node: Record<string, unknown>) => void,
) {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJson(entry, visitor));
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  visitor(object);
  Object.values(object).forEach((entry) => visitJson(entry, visitor));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function typeValues(value: unknown) {
  return arrayValue(value)
    .map(stringValue)
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLowerCase());
}
