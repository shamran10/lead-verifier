import type { AnyNode } from "domhandler";

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

const STRATEGY = "accessible_logo_links" as const;
const LOGO_LINK_SELECTOR =
  "a[href][aria-label], a[href][title], a[href]:has(img[alt])";

export function probeAccessibleLogoLinks(
  html: string,
  sourceUrl: string,
): ExtractionProbe {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = accessibleLogoSections(document);
  const candidateCount = sections.reduce(
    (total, section) =>
      total +
      linksForSection(section).filter((element) =>
        Boolean(
          extractParticipantFromEntry(
            document,
            document.$(element),
            STRATEGY,
            { accessibleNameOnly: true },
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
    confidence: sections.length && candidateCount ? 0.86 : 0,
    warnings: candidateCount
      ? []
      : ["No accessible company-name labels were found in a participant section."],
  };
}

export function extractAccessibleLogoLinks(
  html: string,
  sourceUrl: string,
): StrategyExtractionResult {
  const document = createExtractorDocument(html, sourceUrl);
  const sections = accessibleLogoSections(document);
  const probe = probeAccessibleLogoLinks(html, sourceUrl);
  const participants = sections.flatMap((section) =>
    linksForSection(section)
      .map((element) =>
        extractParticipantFromEntry(document, document.$(element), STRATEGY, {
          accessibleNameOnly: true,
        }),
      )
      .filter((value): value is NonNullable<typeof value> => Boolean(value)),
  );
  return {
    strategy: STRATEGY,
    participants,
    probe,
    warnings: participants.length
      ? []
      : ["The bounded logo section contained no accessible company entries."],
  };
}

function accessibleLogoSections(
  document: ReturnType<typeof createExtractorDocument>,
) {
  const seen = new Set<AnyNode>();
  const sections: BoundedSection[] = [];
  for (const marker of findMarkerElements(document)) {
    const container = nearestBoundedContainer(
      document,
      marker,
      LOGO_LINK_SELECTOR,
    );
    const node = container.get(0);
    if (
      !node ||
      seen.has(node) ||
      isExcludedRoleContainer(document.$, node) ||
      !linksForContainer(container).length
    ) {
      continue;
    }
    seen.add(node);
    sections.push(makeBoundedSection(document, marker, container));
  }
  return sections;
}

function linksForSection(section: BoundedSection) {
  return linksForContainer(section.container);
}

function linksForContainer(container: BoundedSection["container"]) {
  return container.is(LOGO_LINK_SELECTOR)
    ? [container.get(0)!]
    : container.find(LOGO_LINK_SELECTOR).toArray();
}
