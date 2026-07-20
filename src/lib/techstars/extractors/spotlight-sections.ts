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

const STRATEGY = "spotlight_sections" as const;
const SPOTLIGHT_SELECTOR = [
  "[data-company-spotlight]",
  ".company-spotlight",
  ".startup-spotlight",
  ".venture-spotlight",
  "article.spotlight",
  ".speaker-card",
  ".speaker_block",
  ".speaker-block",
  ".speaker-item",
  "[data-speaker-card]",
].join(", ");

export function probeSpotlightSections(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = spotlightSections(document);
  const candidateCount = sections.reduce(
    (total, section) =>
      total +
      entriesForSection(section).filter((element) =>
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
    confidence: sections.length && candidateCount ? 0.92 : 0,
    warnings: [],
  };
}

export function extractSpotlightSections(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = spotlightSections(document);
  const probe = probeSpotlightSections(html, sourceUrl);
  const participants = sections.flatMap((section) =>
    entriesForSection(section)
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
      : ["The bounded spotlight section did not contain usable companies."],
  };
}

function spotlightSections(
  document: ReturnType<typeof createExtractorDocument>,
) {
  const seen = new Set<AnyNode>();
  const sections: BoundedSection[] = [];
  for (const marker of findMarkerElements(document)) {
    const markerText = document.$(marker).text();
    if (!/\b(?:spotlight|meet|showcase|selected|cohort)\b/i.test(markerText)) continue;
    const container = nearestBoundedContainer(
      document,
      marker,
      SPOTLIGHT_SELECTOR,
    );
    const node = container.get(0);
    if (
      !node ||
      seen.has(node) ||
      isExcludedRoleContainer(document.$, node) ||
      !entriesForContainer(container).length
    ) {
      continue;
    }
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, container));
  }
  return sections;
}

function entriesForSection(section: BoundedSection) {
  return entriesForContainer(section.container);
}

function entriesForContainer(container: BoundedSection["container"]) {
  return container.is(SPOTLIGHT_SELECTOR)
    ? [container.get(0)!]
    : container.find(SPOTLIGHT_SELECTOR).toArray();
}
