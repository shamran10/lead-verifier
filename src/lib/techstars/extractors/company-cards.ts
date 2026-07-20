import type { AnyNode } from "domhandler";

import type {
  ExtractionProbe,
  StrategyExtractionResult,
} from "@/lib/techstars/exporter-types";
import {
  createExtractorDocument,
  extractParticipantFromEntry,
  findMarkerElements,
  isExcludedRoleContainer,
  makeBoundedSection,
  nearestBoundedContainer,
  type BoundedSection,
} from "@/lib/techstars/extractors/shared";

const STRATEGY = "company_cards" as const;
const CARD_SELECTOR = [
  "[data-company-card]",
  ".company-card",
  ".startup-card",
  ".venture-card",
  "article.company",
  "article.startup",
  ".speaker-card",
  ".speaker_block",
  ".speaker-block",
  ".speaker-item",
  "[data-speaker-card]",
].join(", ");

export function probeCompanyCards(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = companyCardSections(document);
  const candidateCount = sections.reduce(
    (total, section) =>
      total +
      cardsForSection(section).filter((element) =>
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
    confidence: sections.length && candidateCount ? 0.94 : 0,
    warnings: [],
  };
}

export function extractCompanyCards(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = companyCardSections(document);
  const probe = probeCompanyCards(html, sourceUrl);
  const participants = sections.flatMap((section) =>
    cardsForSection(section)
      .map((element) =>
        extractParticipantFromEntry(document, document.$(element), STRATEGY),
      )
      .filter((value): value is NonNullable<typeof value> => Boolean(value)),
  );
  return {
    strategy: STRATEGY,
    participants,
    probe,
    warnings: participants.length
      ? []
      : ["The bounded company-card section did not contain usable companies."],
  };
}

function companyCardSections(
  document: ReturnType<typeof createExtractorDocument>,
) {
  const seen = new Set<AnyNode>();
  const sections: BoundedSection[] = [];
  for (const marker of findMarkerElements(document)) {
    const container = nearestBoundedContainer(document, marker, CARD_SELECTOR);
    const node = container.get(0);
    if (
      !node ||
      seen.has(node) ||
      isExcludedRoleContainer(document.$, node) ||
      !cardsForContainer(container).length
    ) {
      continue;
    }
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, container));
  }
  return sections;
}

function cardsForSection(section: BoundedSection) {
  return cardsForContainer(section.container);
}

function cardsForContainer(container: BoundedSection["container"]) {
  return container.is(CARD_SELECTOR)
    ? [container.get(0)!]
    : container.find(CARD_SELECTOR).toArray();
}
