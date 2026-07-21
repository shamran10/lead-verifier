import type { CompanyEnrichmentResult } from "@/lib/500-global/company-enrichment";
import type {
  AntlerParticipation,
  AntlerSourceResult,
  AntlerRegion,
  DiscoveredAntlerCompany,
  DuplicateAntlerCompany,
  FilteredAntlerCompany,
} from "@/lib/antler/types";
import { normalizeDomain, normalizeFounderName } from "@/lib/founder-normalization";

export function mergeAntlerSourceResults(results: readonly AntlerSourceResult[]) {
  const companies: DiscoveredAntlerCompany[] = [];
  const duplicates: DuplicateAntlerCompany[] = [];
  const domainIndex = new Map<string, number>();
  const nameIndex = new Map<string, number>();

  for (const extracted of results.flatMap((result) => result.companies)) {
    const domain = extracted.normalized_domain ??
      (extracted.website ? normalizeDomain(extracted.website) : null);
    const nameKey = normalizeCompanyName(extracted.company_name);
    let index = domain ? domainIndex.get(domain) : undefined;
    if (index === undefined) {
      const byName = nameIndex.get(nameKey);
      if (
        byName !== undefined &&
        (!domain || !companies[byName].normalized_domain)
      ) {
        index = byName;
      }
    }
    if (index === undefined) {
      const participation = dedupeParticipation(extracted.participation);
      const primary = primaryParticipation(participation);
      const company: DiscoveredAntlerCompany = {
        ...extracted,
        normalized_domain: domain,
        founders: dedupeFounders(extracted.founders),
        participation,
        source_url: primary.source_url,
        additional_source_urls: participation
          .map((item) => item.source_url)
          .filter((url) => url !== primary.source_url),
        warnings: [...new Set(extracted.warnings)],
        discovery_status: "official_confirmed",
      };
      companies.push(company);
      index = companies.length - 1;
      nameIndex.set(nameKey, index);
      if (domain) domainIndex.set(domain, index);
      continue;
    }

    const existing = companies[index];
    const participation = dedupeParticipation([
      ...existing.participation,
      ...extracted.participation,
    ]);
    const primary = primaryParticipation(participation);
    companies[index] = {
      ...existing,
      website: existing.website ?? extracted.website,
      normalized_domain: existing.normalized_domain ?? domain,
      listed_location: existing.listed_location ?? extracted.listed_location,
      listed_location_evidence:
        existing.listed_location_evidence ?? extracted.listed_location_evidence,
      industry: existing.industry ?? extracted.industry,
      description: existing.description ?? extracted.description,
      founders: dedupeFounders([...existing.founders, ...extracted.founders]),
      participation,
      source_url: primary.source_url,
      additional_source_urls: participation
        .map((item) => item.source_url)
        .filter((url) => url !== primary.source_url),
      warnings: [...new Set([...existing.warnings, ...extracted.warnings])],
    };
    if (domain) domainIndex.set(domain, index);
    duplicates.push({
      company_name: extracted.company_name,
      website: extracted.website ?? "",
      accelerator_year: primary.year,
      reason: domain
        ? `Duplicate Antler participant merged by domain ${domain}.`
        : "Duplicate Antler participant merged by exact normalized company name.",
      source_url: primary.source_url,
    });
  }
  return { companies, duplicates };
}

export function filterAntlerCompany(
  company: DiscoveredAntlerCompany,
  enrichment: CompanyEnrichmentResult,
  regions: readonly AntlerRegion[],
): FilteredAntlerCompany {
  const region = enrichment.headquartersRegion;
  let location_classification: FilteredAntlerCompany["location_classification"];
  if (enrichment.locationStatus === "conflicting") {
    location_classification = "conflicting_location";
  } else if (!enrichment.headquartersCountry) {
    location_classification = "unresolved_location";
  } else if (region && regions.includes(region)) {
    location_classification = region;
  } else {
    location_classification = "outside_target_region";
  }
  return {
    ...company,
    canonical_country: enrichment.headquartersCountry,
    country_iso2: enrichment.headquartersIso2,
    location_classification,
    location_evidence: enrichment.locationEvidence.map(
      (item) => `${item.country.canonicalName}: ${item.snippet} (${item.sourceUrl ?? "official listing"})`,
    ),
    location_warnings: enrichment.warnings,
    company_pages_checked: enrichment.pagesAttempted,
    company_site_failures: enrichment.failures.map(
      (failure) => `${failure.url}: ${failure.reason}`,
    ),
  };
}

export function primaryParticipation(values: readonly AntlerParticipation[]) {
  const sorted = [...values].sort((left, right) => {
    const kindRank = (value: AntlerParticipation) =>
      value.source_kind === "portfolio_directory" ? 2 : 3;
    return kindRank(right) - kindRank(left) || right.year - left.year ||
      left.source_url.localeCompare(right.source_url);
  });
  const first = sorted[0];
  if (!first) throw new Error("An Antler company has no official participation evidence.");
  return first;
}

function dedupeParticipation(values: readonly AntlerParticipation[]) {
  return values.filter(
    (item, index) =>
      values.findIndex(
        (candidate) =>
          candidate.year === item.year &&
          candidate.source_url === item.source_url &&
          candidate.program === item.program,
      ) === index,
  );
}

function dedupeFounders<T extends { founder_name: string; source_url: string }>(values: readonly T[]) {
  return values.filter((item, index) => {
    const key = normalizeFounderName(item.founder_name)?.normalizedFounderName;
    return key && values.findIndex((candidate) =>
      normalizeFounderName(candidate.founder_name)?.normalizedFounderName === key &&
      candidate.source_url === item.source_url,
    ) === index;
  });
}

function normalizeCompanyName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
}
