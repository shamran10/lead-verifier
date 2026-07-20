import type {
  ExporterExtractionStrategy,
  ExtractedExporterParticipant,
  ExtractionProbe,
  StrategyExtractionResult,
} from "@/lib/techstars/exporter-types";
import {
  extractAccessibleLogoLinks,
  probeAccessibleLogoLinks,
} from "@/lib/techstars/extractors/accessible-logo-links";
import {
  extractCompanyCards,
  probeCompanyCards,
} from "@/lib/techstars/extractors/company-cards";
import {
  extractDemoDaySections,
  probeDemoDaySections,
} from "@/lib/techstars/extractors/demo-day-sections";
import {
  extractParticipantList,
  probeParticipantList,
} from "@/lib/techstars/extractors/participant-list";
import {
  extractKnownStructuredData,
  probeKnownStructuredData,
} from "@/lib/techstars/extractors/known-structured-data";
import {
  extractSpotlightSections,
  probeSpotlightSections,
} from "@/lib/techstars/extractors/spotlight-sections";
import { normalizeCompanyNameKey } from "@/lib/techstars/extractors/shared";

type StrategyImplementation = {
  probe(html: string, sourceUrl: string): ExtractionProbe;
  extract(html: string, sourceUrl: string): StrategyExtractionResult;
};

const STRATEGY_IMPLEMENTATIONS: Partial<
  Record<ExporterExtractionStrategy, StrategyImplementation>
> = {
  participant_list: {
    probe: probeParticipantList,
    extract: extractParticipantList,
  },
  company_cards: { probe: probeCompanyCards, extract: extractCompanyCards },
  spotlight_sections: {
    probe: probeSpotlightSections,
    extract: extractSpotlightSections,
  },
  demo_day_sections: {
    probe: probeDemoDaySections,
    extract: extractDemoDaySections,
  },
  accessible_logo_links: {
    probe: probeAccessibleLogoLinks,
    extract: extractAccessibleLogoLinks,
  },
  known_structured_data: {
    probe: probeKnownStructuredData,
    extract: extractKnownStructuredData,
  },
};

export const SUPPORTED_BOUNDED_STRATEGIES = Object.freeze(
  Object.keys(STRATEGY_IMPLEMENTATIONS) as ExporterExtractionStrategy[],
);

export function probeParticipantStrategies(
  html: string,
  sourceUrl: string,
  strategyHints?: readonly ExporterExtractionStrategy[],
) {
  return selectedStrategies(strategyHints).map((strategy) =>
    STRATEGY_IMPLEMENTATIONS[strategy]!.probe(html, sourceUrl),
  );
}

export function extractParticipantStrategies(
  html: string,
  sourceUrl: string,
  strategies: readonly ExporterExtractionStrategy[],
) {
  const strategyResults = selectedStrategies(strategies).map((strategy) =>
    STRATEGY_IMPLEMENTATIONS[strategy]!.extract(html, sourceUrl),
  );
  return {
    strategyResults,
    participants: dedupeParticipants(
      strategyResults.flatMap((result) => result.participants),
    ),
    warnings: [...new Set(strategyResults.flatMap((result) => result.warnings))],
  };
}

function selectedStrategies(
  strategies?: readonly ExporterExtractionStrategy[],
) {
  const requested = strategies?.length
    ? strategies
    : SUPPORTED_BOUNDED_STRATEGIES;
  return [...new Set(requested)].filter(
    (strategy): strategy is keyof typeof STRATEGY_IMPLEMENTATIONS =>
      Boolean(STRATEGY_IMPLEMENTATIONS[strategy]),
  );
}

function dedupeParticipants(values: ExtractedExporterParticipant[]) {
  const output: ExtractedExporterParticipant[] = [];
  const byDomain = new Map<string, number>();
  const byNameWithoutDomain = new Map<string, number>();

  for (const value of values) {
    const nameKey = normalizeCompanyNameKey(value.companyName);
    if (value.normalizedDomain) {
      const domainMatch = byDomain.get(value.normalizedDomain);
      if (domainMatch !== undefined) {
        output[domainMatch] = mergeParticipants(output[domainMatch], value);
        continue;
      }
      const weakNameMatch = byNameWithoutDomain.get(nameKey);
      if (weakNameMatch !== undefined) {
        output[weakNameMatch] = mergeParticipants(output[weakNameMatch], value);
        byDomain.set(value.normalizedDomain, weakNameMatch);
        byNameWithoutDomain.delete(nameKey);
        continue;
      }
      byDomain.set(value.normalizedDomain, output.length);
      output.push(value);
      continue;
    }

    const existingWeak = byNameWithoutDomain.get(nameKey);
    if (existingWeak !== undefined) {
      output[existingWeak] = mergeParticipants(output[existingWeak], value);
      continue;
    }
    const domainBackedName = output.findIndex(
      (candidate) =>
        candidate.normalizedDomain !== null &&
        normalizeCompanyNameKey(candidate.companyName) === nameKey,
    );
    if (domainBackedName >= 0) {
      output[domainBackedName] = mergeParticipants(
        output[domainBackedName],
        value,
      );
      continue;
    }
    byNameWithoutDomain.set(nameKey, output.length);
    output.push(value);
  }
  return output;
}

function mergeParticipants(
  preferred: ExtractedExporterParticipant,
  additional: ExtractedExporterParticipant,
) {
  const countryConflict =
    Boolean(preferred.listedCountry && additional.listedCountry) &&
    normalizeCountryKey(preferred.listedCountry!) !==
      normalizeCountryKey(additional.listedCountry!);
  const founderNames = new Set(
    preferred.founders.map((founder) =>
      normalizeCompanyNameKey(founder.founderName),
    ),
  );
  return {
    ...preferred,
    website: preferred.website ?? additional.website,
    normalizedDomain:
      preferred.normalizedDomain ?? additional.normalizedDomain,
    listedCountry: countryConflict
      ? null
      : preferred.listedCountry ?? additional.listedCountry,
    listedCountryEvidence: countryConflict
      ? null
      : preferred.listedCountry
        ? preferred.listedCountryEvidence ?? "ambiguous"
        : additional.listedCountryEvidence ?? null,
    industry: preferred.industry ?? additional.industry,
    description: preferred.description ?? additional.description,
    founders: [
      ...preferred.founders,
      ...additional.founders.filter(
        (founder) =>
          !founderNames.has(normalizeCompanyNameKey(founder.founderName)),
      ),
    ],
    evidenceSnippet:
      preferred.evidenceSnippet.length >= additional.evidenceSnippet.length
        ? preferred.evidenceSnippet
        : additional.evidenceSnippet,
    warnings: [
      ...new Set([
        ...preferred.warnings,
        ...additional.warnings,
        ...(countryConflict
          ? ["Extraction strategies produced conflicting company-location values."]
          : []),
      ]),
    ],
  };
}

function normalizeCountryKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}
