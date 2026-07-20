import type { AnyNode, Element } from "domhandler";
import type { Cheerio } from "cheerio";

import type {
  ExtractionProbe,
  StrategyExtractionResult,
} from "@/lib/masschallenge/exporter-types";
import {
  createExtractorDocument,
  extractParticipantFromEntry,
  findMarkerElements,
  isExcludedRoleContainer,
  makeBoundedSection,
  nearestBoundedContainer,
  type BoundedSection,
} from "@/lib/masschallenge/extractors/shared";
import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";

const STRATEGY = "participant_list" as const;
const PARTICIPANT_ENTRY_SELECTOR = "li, tbody tr, table tr, p";

export function probeParticipantList(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = participantListSections(document);
  const candidateCount = sections.reduce(
    (total, section) =>
      total +
      entriesForSection(section)
        .toArray()
        .filter((element) => isParticipantEntry(document, element))
        .filter((element) =>
          Boolean(
            extractParticipantFromEntry(
              document,
              document.$(element),
              STRATEGY,
            ),
          ),
        ).length,
    0,
  );
  return {
    strategy: STRATEGY,
    markerFound: findMarkerElements(document).length > 0,
    boundedSectionCount: sections.length,
    candidateCount,
    confidence: sections.length && candidateCount ? 0.96 : 0,
    warnings: [],
  };
}

export function extractParticipantList(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = participantListSections(document);
  const probe = probeParticipantList(html, sourceUrl);
  const participants = sections.flatMap((section) =>
    entriesForSection(section)
      .toArray()
      .filter((element) => isParticipantEntry(document, element))
      .map((element) =>
        extractParticipantFromEntry(document, document.$(element), STRATEGY),
      )
      .filter((value): value is NonNullable<typeof value> => Boolean(value)),
  );
  attachFounderMentions(document, participants);
  return {
    strategy: STRATEGY,
    participants,
    probe: { ...probe, candidateCount: participants.length || probe.candidateCount },
    warnings: participants.length
      ? []
      : ["The bounded participant list did not contain usable company entries."],
  };
}

function attachFounderMentions(
  document: ReturnType<typeof createExtractorDocument>,
  participants: StrategyExtractionResult["participants"],
) {
  const { $, sourceUrl } = document;
  $("a[href*='linkedin.com']").each((_, element) => {
    const anchor = $(element);
    const founderName = cleanText(anchor.text());
    const normalizedFounder = normalizeFounderName(founderName);
    if (!normalizedFounder?.lastName) return;

    const block = anchor.closest("p, li").first();
    const blockText = cleanText(block.text());
    if (!/\bfounder\b/i.test(blockText)) return;
    const company = followingParticipantLink(
      document,
      block.find("a[href]").toArray(),
      element,
      participants,
    );
    if (!company) return;

    const founderPosition = blockText
      .toLowerCase()
      .indexOf(founderName.toLowerCase());
    const companyPosition = blockText
      .toLowerCase()
      .indexOf(company.companyName.toLowerCase(), founderPosition + founderName.length);
    if (founderPosition < 0 || companyPosition <= founderPosition) return;
    const role = cleanText(
      blockText
        .slice(founderPosition + founderName.length, companyPosition)
        .replace(/^[,;:\s]+/, "")
        .replace(/\s+(?:of|at)\s*$/i, ""),
    );
    if (
      !/\b(?:co[\s-]?founder|founder)\b/i.test(role) ||
      /\b(?:former|ex[\s-]?founder|advisor|mentor|investor|speaker|alumni)\b/i.test(role)
    ) {
      return;
    }

    const linkedinUrl = publicLinkedInUrl(anchor.attr("href"), sourceUrl);
    if (!linkedinUrl) return;
    const founderKey = normalizedFounder.normalizedFounderName;
    if (
      company.founders.some(
        (founder) =>
          normalizeFounderName(founder.founderName)?.normalizedFounderName === founderKey,
      )
    ) {
      return;
    }
    company.founders.push({
      founderName: founderName.slice(0, 200),
      founderRole: role.slice(0, 120),
      linkedinUrl,
      sourceUrl,
      confidence: 0.9,
    });
  });
}

function followingParticipantLink(
  document: ReturnType<typeof createExtractorDocument>,
  links: Element[],
  founderElement: Element,
  participants: StrategyExtractionResult["participants"],
) {
  const founderIndex = links.indexOf(founderElement);
  if (founderIndex < 0) return null;
  for (const link of links.slice(founderIndex + 1)) {
    const href = document.$(link).attr("href") ?? "";
    if (/linkedin\.com/i.test(href)) return null;
    let domain: string | null = null;
    try {
      domain = normalizeDomain(new URL(href, document.sourceUrl).toString());
    } catch {
      domain = null;
    }
    if (!domain) continue;
    const participant = participants.find(
      (candidate) => candidate.normalizedDomain === domain,
    );
    if (participant) return participant;
  }
  return null;
}

function publicLinkedInUrl(value: string | undefined, sourceUrl: string) {
  if (!value) return null;
  try {
    const url = new URL(value, sourceUrl);
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

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function participantListSections(
  document: ReturnType<typeof createExtractorDocument>,
) {
  const seen = new Set<AnyNode>();
  const sections: BoundedSection[] = [];
  const flatPriorities = new Map<AnyNode, number>();
  for (const marker of findMarkerElements(document)) {
    const container = flatParticipantRange(document, marker);
    const node = container.get(0);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, container));
    flatPriorities.set(node, flatMarkerPriority(cleanText(document.$(marker).text())));
  }
  if (sections.length) {
    const highestPriority = Math.max(
      ...sections.map((section) => flatPriorities.get(section.container.get(0)!) ?? 0),
    );
    return sections.filter(
      (section) =>
        (flatPriorities.get(section.container.get(0)!) ?? 0) === highestPriority,
    );
  }

  for (const marker of findMarkerElements(document)) {
    const container = nearestBoundedContainer(document, marker, "ul, ol, table, p");
    if (!container.length) continue;
    const section = container.first();
    const node = section.get(0);
    if (
      !node ||
      seen.has(node) ||
      isExcludedRoleContainer(document.$, node) ||
      !section
        .filter(PARTICIPANT_ENTRY_SELECTOR)
        .add(section.find(PARTICIPANT_ENTRY_SELECTOR))
        .toArray()
        .some((element) =>
        isParticipantEntry(document, element),
      )
    ) {
      continue;
    }
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, section));
  }
  return sections;
}

function flatMarkerPriority(value: string) {
  if (
    /^meet\b.*\b(?:cohort|companies|finalists?|participants?|startups?|ventures?|winners?)\b/i.test(value) ||
    /\b(?:program|cohort)\s+finalists?\b/i.test(value)
  ) {
    return 100;
  }
  if (
    /\b(?:selected|chosen|accepted|welcom(?:e|es|ed|ing))\b/i.test(value) &&
    /\b(?:companies|participants?|startups?|ventures?|finalists?)\b/i.test(value)
  ) {
    return 50;
  }
  return 10;
}

function flatParticipantRange(
  document: ReturnType<typeof createExtractorDocument>,
  marker: AnyNode,
) {
  const markerBlock = document.$(marker).closest("h1, h2, h3, h4, p").first();
  const markerText = cleanText(markerBlock.text());
  if (
    !markerBlock.length ||
    markerText.length > 400 ||
    !/\b(?:cohort|companies|finalists?|participants?|startups?|ventures?|winners?)\b/i.test(markerText)
  ) {
    return document.$([]);
  }

  let range = document.$([]) as Cheerio<AnyNode>;
  let current = markerBlock.next() as Cheerio<AnyNode>;
  let foundParticipant = false;
  while (current.length) {
    const text = cleanText(current.text());
    const strongHeading = cleanText(current.find("strong").first().text());
    const isMajorBoundary =
      current.is("h1") ||
      (current.is("h2") &&
        /\b(?:about|call for|contact|looking ahead|what(?:'s| is) next|why this)\b/i.test(text)) ||
      (foundParticipant &&
        current.is("p") &&
        strongHeading.length >= 3 &&
        strongHeading.length <= 160 &&
        text.length <= 220 &&
        /^(?:about|call for|contact|from emerging|interested|looking ahead|what(?:'s| is) next|why this|you(?:'re| are) invited)\b/i.test(
          strongHeading,
        ) &&
        !/\([^)]{2,100}\)\s*:/i.test(text));
    if (foundParticipant && isMajorBoundary) break;
    range = range.add(current);
    const entries = current
      .filter(PARTICIPANT_ENTRY_SELECTOR)
      .add(current.find(PARTICIPANT_ENTRY_SELECTOR));
    if (entries.toArray().some((element) => isParticipantEntry(document, element))) {
      foundParticipant = true;
    }
    current = current.next();
  }
  return foundParticipant ? range : document.$([]);
}

function entriesForSection(section: BoundedSection) {
  return section.container
    .filter(PARTICIPANT_ENTRY_SELECTOR)
    .add(section.container.find(PARTICIPANT_ENTRY_SELECTOR));
}

function isParticipantEntry(
  document: ReturnType<typeof createExtractorDocument>,
  element: AnyNode,
) {
  const entry = document.$(element);
  if (isExcludedRoleContainer(document.$, element)) return false;
  if (entry.is("p")) {
    const text = cleanText(entry.text());
    const hasRosterLocation = /^[^:]{2,180}\s+\([^)]{2,100}\)\s*:/i.test(text);
    const hasExternalStrongLink = entry.find("a[href]").toArray().some((anchor) => {
      if (!cleanText(document.$(anchor).find("strong").first().text())) return false;
      try {
        const url = new URL(
          document.$(anchor).attr("href") ?? "",
          document.sourceUrl,
        );
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        return (
          Boolean(host) &&
          host !== document.sourceHostname &&
          !/(?:^|\.)linkedin\.com$/i.test(host)
        );
      } catch {
        return false;
      }
    });
    return hasRosterLocation || hasExternalStrongLink;
  }
  if (entry.is("tr")) {
    const cells = entry.find("td");
    return (
      cells.length >= 1 &&
      !/^(?:startup|company|name)\b/i.test(cleanText(cells.first().text()))
    );
  }
  return true;
}
