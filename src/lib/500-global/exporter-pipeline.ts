import type {
  ExportedCompanyFounder,
  ExporterCompanyRecord,
  ExporterFinalCompany,
  ValidatedSourceExtraction,
} from "@/lib/500-global/exporter-pipeline-types";
import type { ExporterSourceKind } from "@/lib/500-global/exporter-types";
import { normalizeFounderName } from "@/lib/founder-normalization";
import { normalizeDomain } from "@/lib/founder-normalization";
import type { ReadyForUploadRow } from "@/lib/500-global/xlsx-export";

export type DuplicateCompanyAudit = {
  companyName: string;
  website: string | null;
  acceleratorYear: number | null;
  reason: string;
  sourceUrl: string;
  sourceKind: ExporterSourceKind;
  extractionStrategy: string;
};

export function mergeValidatedSourceExtractions(
  extractions: readonly ValidatedSourceExtraction[],
) {
  const companies: ExporterCompanyRecord[] = [];
  const byDomain = new Map<string, number>();
  const byName = new Map<string, Set<number>>();
  const duplicates: DuplicateCompanyAudit[] = [];

  for (const extraction of extractions) {
    for (const participant of extraction.participants) {
      const domain = participant.normalizedDomain ?? normalizeDomain(participant.website ?? "");
      const nameKey = normalizeCompanyKey(participant.companyName);
      const domainMatch = domain ? byDomain.get(domain) : undefined;
      const nameMatches = byName.get(nameKey);
      const weakMatch = domain
        ? [...(nameMatches ?? [])].find(
            (index) => companies[index].normalizedDomain === null,
          )
        : nameMatches?.size === 1
          ? [...nameMatches][0]
          : undefined;
      const match = domainMatch ?? weakMatch;
      const next = participantToCompany(extraction, participant, domain);
      if (match === undefined) {
        const index = companies.length;
        companies.push(next);
        if (domain) byDomain.set(domain, index);
        addNameMatch(byName, nameKey, index);
        continue;
      }

      const current = companies[match];
      companies[match] = mergeCompany(current, next);
      if (domain) {
        byDomain.set(domain, match);
      }
      addNameMatch(byName, nameKey, match);
      duplicates.push({
        companyName: participant.companyName,
        website: participant.website,
        acceleratorYear: extraction.source.acceleratorYear,
        reason: `Duplicate participant merged into ${companies[match].companyName}; supporting source retained.`,
        sourceUrl: extraction.source.url,
        sourceKind: extraction.source.sourceKind,
        extractionStrategy: participant.extractionStrategy,
      });
    }
  }
  return { companies, duplicates };
}

export function classifyFinalCompanies(
  companies: readonly ExporterFinalCompany[],
  targetYears: readonly number[],
  targetRegions: readonly string[],
) {
  const ready: ReadyForUploadRow[] = [];
  const needsReview: ExporterFinalCompany[] = [];
  const excluded: Array<ExporterFinalCompany & { exclusionReason: string }> = [];
  const targetRegionLabel = formatTargetRegions(targetRegions);

  for (const company of companies) {
    if (!targetYears.includes(company.acceleratorYear)) {
      excluded.push({ ...company, exclusionReason: "Accelerator year is outside the requested years." });
      continue;
    }
    if (
      company.locationStatus === "confirmed" &&
      (!company.headquartersRegion || !targetRegions.includes(company.headquartersRegion))
    ) {
      excluded.push({
        ...company,
        exclusionReason: `Confirmed company location${company.headquartersCountry ? ` in ${company.headquartersCountry}` : ""} is outside ${targetRegionLabel}.`,
      });
      continue;
    }
    const reviewReasons = [...company.reviewReasons];
    if (!company.website || !company.normalizedDomain) reviewReasons.push("Company website is missing or unusable.");
    if (company.locationStatus === "missing") reviewReasons.push("Headquarters/current main location is missing.");
    if (company.locationStatus === "conflicting") reviewReasons.push("Headquarters/current-location evidence conflicts.");
    if (company.locationStatus === "confirmed" && !company.headquartersRegion) {
      reviewReasons.push("Company location is not in a requested region.");
    }
    const activeFounders = confirmedActiveFounders(company.founders).slice(0, 4);
    if (!activeFounders.length) reviewReasons.push("No confirmed active founder was found.");
    if (!isUploadCompatibleSource(company.sourceUrl)) {
      reviewReasons.push("Primary membership source is not accepted by the existing upload parser.");
    }
    if (reviewReasons.length) {
      needsReview.push({ ...company, reviewReasons: [...new Set(reviewReasons)] });
      continue;
    }
    ready.push(toReadyRow(company, activeFounders));
  }
  return { ready, needsReview, excluded };
}

function participantToCompany(
  extraction: ValidatedSourceExtraction,
  participant: ValidatedSourceExtraction["participants"][number],
  normalizedDomain: string | null,
): ExporterCompanyRecord {
  return {
    companyName: participant.companyName,
    website: participant.website,
    normalizedDomain,
    acceleratorName: "500 Global",
    acceleratorBatch: extraction.source.acceleratorBatch,
    acceleratorYear: extraction.source.acceleratorYear,
    sourceUrl: extraction.source.url,
    sourceKind: extraction.source.sourceKind,
    officialMembershipStatus: "confirmed",
    listedCountry: participant.listedCountry,
    listedCountryEvidence: participant.listedCountry
      ? participant.listedCountryEvidence ?? "ambiguous"
      : null,
    industry: participant.industry,
    description: participant.description,
    founders: participant.founders.map((founder) => ({
      founderName: founder.founderName,
      founderRole: founder.founderRole,
      linkedinUrl: founder.linkedinUrl,
      sourceUrl: founder.sourceUrl,
      confidence: founder.confidence,
      activeStatus: explicitFounderStatus(founder.founderRole),
    })),
    supportingSourceUrls: [extraction.source.url],
    extractionStrategies: [participant.extractionStrategy],
    warnings: [...new Set([...participant.warnings, ...extraction.warnings])],
    evidenceStrength: evidenceStrength(extraction.source.sourceKind),
  };
}

function mergeCompany(left: ExporterCompanyRecord, right: ExporterCompanyRecord) {
  const stronger = right.evidenceStrength > left.evidenceStrength ? right : left;
  const weaker = stronger === right ? left : right;
  const countryConflict =
    Boolean(left.listedCountry && right.listedCountry) &&
    normalizeCountryValue(left.listedCountry!) !==
      normalizeCountryValue(right.listedCountry!);
  const selectedCountry = selectListedCountry(stronger, weaker, countryConflict);
  return {
    ...stronger,
    website: stronger.website ?? weaker.website,
    normalizedDomain: stronger.normalizedDomain ?? weaker.normalizedDomain,
    acceleratorBatch: stronger.acceleratorBatch ?? weaker.acceleratorBatch,
    listedCountry: selectedCountry.value,
    listedCountryEvidence: selectedCountry.evidence,
    industry: stronger.industry ?? weaker.industry,
    description: stronger.description ?? weaker.description,
    founders: mergeFounderEvidence([...left.founders, ...right.founders]),
    supportingSourceUrls: [...new Set([...left.supportingSourceUrls, ...right.supportingSourceUrls])],
    extractionStrategies: [...new Set([...left.extractionStrategies, ...right.extractionStrategies])],
    warnings: [
      ...new Set([
        ...left.warnings,
        ...right.warnings,
        ...(countryConflict
          ? ["Official participant sources contain conflicting company-location values."]
          : []),
      ]),
    ],
  };
}

function dedupeFounders(founders: readonly ExportedCompanyFounder[]) {
  const result = new Map<string, ExportedCompanyFounder>();
  for (const founder of founders) {
    const key = normalizeFounderName(founder.founderName)?.normalizedFounderName;
    if (!key) continue;
    const existing = result.get(key);
    if (!existing || founderRank(founder) > founderRank(existing)) result.set(key, founder);
  }
  return [...result.values()];
}

function mergeFounderEvidence(founders: readonly ExportedCompanyFounder[]) {
  const result = new Map<string, ExportedCompanyFounder>();
  for (const founder of founders) {
    const name = normalizeFounderName(founder.founderName)?.normalizedFounderName;
    if (!name) continue;
    const key = `${name}\u0000${founder.activeStatus}`;
    const existing = result.get(key);
    if (!existing || founderRank(founder) > founderRank(existing)) {
      result.set(key, founder);
    }
  }
  return [...result.values()];
}

function confirmedActiveFounders(founders: readonly ExportedCompanyFounder[]) {
  const byName = new Map<string, ExportedCompanyFounder[]>();
  for (const founder of founders) {
    const key = normalizeFounderName(founder.founderName)?.normalizedFounderName;
    if (!key) continue;
    const evidence = byName.get(key) ?? [];
    evidence.push(founder);
    byName.set(key, evidence);
  }
  const confirmed: ExportedCompanyFounder[] = [];
  for (const evidence of byName.values()) {
    const statuses = new Set(evidence.map((founder) => founder.activeStatus));
    if (statuses.size !== 1 || !statuses.has("confirmed")) continue;
    confirmed.push(dedupeFounders(evidence)[0]);
  }
  return confirmed.filter(Boolean);
}

function founderRank(founder: ExportedCompanyFounder) {
  const active = founder.activeStatus === "confirmed" ? 100 : founder.activeStatus === "possible" ? 50 : 0;
  return active + founder.confidence * 10 + (founder.linkedinUrl ? 1 : 0);
}

function toReadyRow(
  company: ExporterFinalCompany,
  founders: ExportedCompanyFounder[],
): ReadyForUploadRow {
  const founder = (index: number) => founders[index];
  return {
    company_name: company.companyName,
    website: company.website ?? "",
    accelerator_batch: company.acceleratorBatch ?? "",
    accelerator_year: company.acceleratorYear,
    country: company.headquartersCountry ?? "",
    industry: company.industry ?? "",
    description: company.description ?? "",
    founder_name: founder(0)?.founderName ?? "",
    founder_role: founder(0)?.founderRole ?? "",
    linkedin_url: founder(0)?.linkedinUrl ?? "",
    founder_2: founder(1)?.founderName ?? "",
    linkedin_url_2: founder(1)?.linkedinUrl ?? "",
    founder_3: founder(2)?.founderName ?? "",
    linkedin_url_3: founder(2)?.linkedinUrl ?? "",
    founder_4: founder(3)?.founderName ?? "",
    linkedin_url_4: founder(3)?.linkedinUrl ?? "",
    source_url: company.sourceUrl,
  };
}

function explicitFounderStatus(role: string | null): ExportedCompanyFounder["activeStatus"] {
  if (!role) return "possible";
  if (/\b(former|ex[ -]?founder|alumni)\b/i.test(role)) return "former";
  if (/\b(advisor|mentor|investor|speaker)\b/i.test(role)) return "possible";
  return /\b(?:co[ -]?founder|founder)\b/i.test(role) ? "confirmed" : "unknown";
}

function evidenceStrength(kind: ExporterSourceKind) {
  return {
    cohort_roster: 100,
    announcement: 95,
    demo_day: 90,
    partner_program: 80,
    regional_program: 75,
    event_page: 70,
    manual_catalog: 60,
  }[kind];
}

function isUploadCompatibleSource(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && (host === "500.co" || host.endsWith(".500.co"));
  } catch {
    return false;
  }
}

function normalizeCompanyKey(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeCountryValue(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function selectListedCountry(
  stronger: ExporterCompanyRecord,
  weaker: ExporterCompanyRecord,
  conflict: boolean,
) {
  if (conflict) return { value: null, evidence: null };
  const candidates = [stronger, weaker].filter(
    (company) => company.listedCountry,
  );
  const selected =
    candidates.find(
      (company) => company.listedCountryEvidence === "company_specific",
    ) ?? candidates[0];
  return {
    value: selected?.listedCountry ?? null,
    evidence: selected?.listedCountryEvidence ?? null,
  };
}

function addNameMatch(
  matches: Map<string, Set<number>>,
  nameKey: string,
  index: number,
) {
  const indexes = matches.get(nameKey) ?? new Set<number>();
  indexes.add(index);
  matches.set(nameKey, indexes);
}

function formatTargetRegions(regions: readonly string[]) {
  const names = regions.map((region) =>
    region === "north_america"
      ? "North America"
      : region === "europe"
        ? "Europe"
        : region,
  );
  if (names.length <= 1) return names[0] ?? "the requested regions";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
