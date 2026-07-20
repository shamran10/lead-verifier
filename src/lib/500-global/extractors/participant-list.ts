import type { AnyNode, Element } from "domhandler";

import type {
  ExtractionProbe,
  StrategyExtractionResult,
} from "@/lib/500-global/exporter-types";
import {
  createExtractorDocument,
  extractParticipantFromEntry,
  findMarkerElements,
  isExcludedRoleContainer,
  makeBoundedSection,
  nearestBoundedContainer,
  type BoundedSection,
} from "@/lib/500-global/extractors/shared";
import {
  normalizeDomain,
  normalizeFounderName,
} from "@/lib/founder-normalization";

const STRATEGY = "participant_list" as const;

export function probeParticipantList(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = participantListSections(document);
  const candidateCount = sections.reduce(
    (total, section) =>
      total +
      section.container
        .find("li")
        .toArray()
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
    section.container
      .find("li")
      .toArray()
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
  for (const marker of findMarkerElements(document)) {
    const container = nearestBoundedContainer(document, marker, "ul, ol");
    if (!container.length) continue;
    const list = container.is("ul, ol")
      ? container.first()
      : container.find("ul, ol").first();
    const node = list.get(0);
    if (
      !node ||
      seen.has(node) ||
      isExcludedRoleContainer(document.$, node) ||
      !list.find("li").length
    ) {
      continue;
    }
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, list));
  }
  return sections;
}
