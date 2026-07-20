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

const STRATEGY = "demo_day_sections" as const;
const DEMO_ENTRY_SELECTOR = [
  "[data-demo-company]",
  ".demo-company",
  ".presenting-startup",
  ".presenting-company",
  ".startup-pitch",
  "article.startup",
  ".speaker-card",
  ".speaker_block",
  ".speaker-block",
  ".speaker-item",
  "[data-speaker-card]",
].join(", ");

export function probeDemoDaySections(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = demoDaySections(document);
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
    markerFound: findMarkerElements(document).some((marker) =>
      /\b(?:demo\s+day|presenting|pitching|showcase)\b/i.test(
        document.$(marker).text(),
      ),
    ),
    boundedSectionCount: sections.length,
    candidateCount,
    confidence: sections.length && candidateCount ? 0.95 : 0,
    warnings: [],
  };
}

export function extractDemoDaySections(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = demoDaySections(document);
  const probe = probeDemoDaySections(html, sourceUrl);
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
      : ["The bounded demo-day participant section had no usable companies."],
  };
}

function demoDaySections(
  document: ReturnType<typeof createExtractorDocument>,
) {
  const seen = new Set<AnyNode>();
  const sections: BoundedSection[] = [];
  for (const marker of findMarkerElements(document)) {
    const markerText = document.$(marker).text();
    if (!/\b(?:demo\s+day|presenting|pitching|showcase)\b/i.test(markerText)) {
      continue;
    }
    const container = nearestBoundedContainer(
      document,
      marker,
      DEMO_ENTRY_SELECTOR,
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
  return container.is(DEMO_ENTRY_SELECTOR)
    ? [container.get(0)!]
    : container.find(DEMO_ENTRY_SELECTOR).toArray();
}
