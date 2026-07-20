import { load } from "cheerio";

import type {
  ExporterSourceKind,
  ExporterYear,
  SourceCandidate,
  SourceValidationOptions,
  SourceValidationReasonCode,
  SourceValidationResult,
  ValidatedExporterSource,
  ValidatedSourceExtraction,
} from "@/lib/masschallenge/exporter-types";
import {
  EXPORTER_SOURCE_KINDS,
} from "@/lib/masschallenge/exporter-types";
import {
  extractParticipantStrategies,
  probeParticipantStrategies,
} from "@/lib/masschallenge/extractors";
import {
  cleanText,
  createExtractorDocument,
  findMarkerElements,
  isExplicitParticipantAssertion,
} from "@/lib/masschallenge/extractors/shared";

const DEFAULT_TARGET_YEARS = [2025, 2026] as const;
const OFFICIAL_HOST = "masschallenge.org";
const APPLICATION_ONLY =
  /\b(?:applications?\s+(?:are\s+)?open|apply\s+(?:now|today|here)|submit\s+an?\s+application|join\s+(?:the|our)\s+(?:accelerator|program)|application\s+deadline)\b/i;
const GENERAL_PROGRAM =
  /\b(?:our\s+(?:accelerator|program)\s+(?:helps|supports|provides)|program\s+overview|what\s+we\s+offer|curriculum|eligibility\s+requirements)\b/i;
const HISTORICAL_PORTFOLIO =
  /\b(?:all\s+portfolio\s+companies|browse\s+(?:our|the)\s+portfolio|historical\s+portfolio|portfolio\s+directory)\b/i;

export function validateParticipantSource(
  html: string,
  candidate: SourceCandidate,
  options: SourceValidationOptions = {},
): SourceValidationResult {
  const warnings: string[] = [];
  const reasons: SourceValidationReasonCode[] = [];
  const normalizedUrl = normalizeCandidateUrl(candidate.url);
  if (!normalizedUrl) {
    return rejected(["invalid_url"], ["The candidate is not a valid HTTPS URL."]);
  }

  const url = new URL(normalizedUrl);
  const approvedPartnerHosts = normalizeApprovedHosts(
    options.approvedPartnerHosts ?? [],
  );
  const officialHost = isHostOrSubdomain(url.hostname, OFFICIAL_HOST);
  const approvedPartnerHost = approvedPartnerHosts.some((host) =>
    isHostOrSubdomain(url.hostname, host),
  );
  if (!officialHost && !approvedPartnerHost) {
    return rejected(
      ["unapproved_host"],
      ["The source host is neither an official MassChallenge host nor an explicitly approved partner host."],
    );
  }

  const $ = load(html);
  const pageTitle = cleanText(
    $("meta[property='og:title']").attr("content") ?? $("title").first().text(),
  ).slice(0, 500) || null;
  const publishedDate = extractPublishedDate($);
  const mainText = cleanText(
    $("main").first().text() || $("body").text(),
  ).slice(0, 100_000);
  if (!officialHost && !/\bMassChallenge\b/i.test(`${pageTitle ?? ""} ${mainText}`)) {
    reasons.push("missing_masschallenge_attribution");
  }

  const document = createExtractorDocument(html, normalizedUrl);
  const participantAssertions = findMarkerElements(document)
    .map((element) => cleanText(document.$(element).text()).slice(0, 400))
    .filter(Boolean);
  const targetYears = normalizeTargetYears(options.targetYears);
  const yearResult = determineSourceYear(
    candidate,
    normalizedUrl,
    pageTitle,
    participantAssertions,
    targetYears,
  );
  if (!yearResult.year) reasons.push(yearResult.reason ?? "unsupported_year");
  warnings.push(...yearResult.warnings);

  const sourceKind = determineSourceKind(candidate, normalizedUrl, pageTitle, mainText);
  if (!sourceKind) reasons.push("unsupported_source_kind");

  if (!participantAssertions.length) reasons.push("no_participant_assertion");
  const hasExplicitMembershipAssertion = participantAssertions.some(
    isExplicitParticipantAssertion,
  );
  const pageHeading = cleanText($("h1").first().text()).slice(0, 500);
  const intentHeading = `${pageTitle ?? ""} ${pageHeading} ${candidate.acceleratorBatchHint ?? ""} ${normalizedUrl}`;
  const applicationOnlyTitle =
    /\bapplications?\s+(?:are\s+|now\s+)?open\b|\bapply\s+(?:now|today)\b/i.test(
      pageTitle ?? "",
    );
  const rosterIntent =
    /\b(?:class|cohort|challenge|finalists?|demo\s+day|winners?)\b/i.test(intentHeading) ||
    /\b(?:meet|introduc\w*|welcom\w*|announc\w*|selected|chosen)\b.{0,120}\b(?:startups?|companies|finalists?|participants?)\b/i.test(
      intentHeading,
    ) ||
    /\bMassChallenge\s+Update\b/i.test(intentHeading);
  if (applicationOnlyTitle) reasons.push("application_only");
  if (/\bStartup Weekend\b/i.test(intentHeading)) {
    reasons.push("general_program_only");
  }
  if (hasExplicitMembershipAssertion && !rosterIntent) {
    reasons.push("no_participant_assertion");
  }
  if (!hasExplicitMembershipAssertion) {
    reasons.push("no_participant_assertion");
    if (APPLICATION_ONLY.test(mainText)) reasons.push("application_only");
    if (
      HISTORICAL_PORTFOLIO.test(mainText) ||
      /\/portfolio(?:\/|$)/i.test(url.pathname)
    ) {
      reasons.push("historical_portfolio");
    }
    if (GENERAL_PROGRAM.test(mainText)) reasons.push("general_program_only");
  }

  const probes = probeParticipantStrategies(
    html,
    normalizedUrl,
    candidate.strategyHints,
  );
  const acceptedProbes = probes.filter(
    (probe) =>
      probe.markerFound &&
      probe.boundedSectionCount > 0 &&
      probe.candidateCount > 0,
  );
  if (!acceptedProbes.length) {
    if (participantAssertions.length) reasons.push("unbounded_participant_section");
    reasons.push("no_extractable_participants");
  }

  if (reasons.length || !yearResult.year || !sourceKind) {
    return rejected([...new Set(reasons)], warnings, probes);
  }

  if (!pageTitle) warnings.push("The source page did not expose a usable title.");
  const source: ValidatedExporterSource = {
    url: normalizedUrl,
    originalUrl: candidate.originalUrl ?? candidate.url,
    hostname: url.hostname,
    sourceKind,
    acceleratorYear: yearResult.year,
    acceleratorBatch: cleanNullable(candidate.acceleratorBatchHint, 160),
    pageTitle,
    publishedDate,
    strategies: acceptedProbes.map((probe) => probe.strategy),
    participantAssertions: [...new Set(participantAssertions)],
    expectedMinimumCompanies: positiveIntegerOrNull(
      candidate.expectedMinimumCompanies,
    ),
    expectedApproximateCompanies: positiveIntegerOrNull(
      candidate.expectedApproximateCompanies,
    ),
    warnings: [...new Set(warnings)],
  };
  return {
    disposition: "accepted",
    accepted: true,
    source,
    reasonCodes: [],
    warnings: source.warnings,
    probes,
  };
}

export function extractValidatedParticipants(
  html: string,
  source: ValidatedExporterSource,
): ValidatedSourceExtraction {
  const extraction = extractParticipantStrategies(
    html,
    source.url,
    source.strategies,
  );
  const warnings = [...extraction.warnings];
  if (
    source.expectedMinimumCompanies !== null &&
    extraction.participants.length < source.expectedMinimumCompanies
  ) {
    warnings.push(
      `The verified source yielded ${extraction.participants.length} companies, fewer than the expected minimum of ${source.expectedMinimumCompanies}.`,
    );
  }
  if (
    source.expectedApproximateCompanies !== null &&
    extraction.participants.length !== source.expectedApproximateCompanies
  ) {
    warnings.push(
      `The source yielded ${extraction.participants.length} companies; approximately ${source.expectedApproximateCompanies} were expected.`,
    );
  }
  return {
    source,
    participants: extraction.participants,
    strategyResults: extraction.strategyResults,
    warnings: [...new Set(warnings)],
  };
}

export function validateAndExtractParticipantSource(
  html: string,
  candidate: SourceCandidate,
  options: SourceValidationOptions = {},
) {
  const validation = validateParticipantSource(html, candidate, options);
  return {
    validation,
    extraction:
      validation.accepted && validation.source
        ? extractValidatedParticipants(html, validation.source)
        : null,
  };
}

function rejected(
  reasonCodes: SourceValidationReasonCode[],
  warnings: string[],
  probes: SourceValidationResult["probes"] = [],
): SourceValidationResult {
  return {
    disposition: "rejected",
    accepted: false,
    source: null,
    reasonCodes: [...new Set(reasonCodes)],
    warnings: [...new Set(warnings)],
    probes,
  };
}

function normalizeCandidateUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return null;
    }
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeApprovedHosts(values: readonly string[]) {
  return values
    .map((value) => value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, ""))
    .filter((value) => value.includes(".") && !/[/:@]/.test(value));
}

function isHostOrSubdomain(hostnameValue: string, approvedHost: string) {
  const hostname = hostnameValue.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return hostname === approvedHost || hostname.endsWith(`.${approvedHost}`);
}

function determineSourceYear(
  candidate: SourceCandidate,
  sourceUrl: string,
  pageTitle: string | null,
  participantAssertions: readonly string[],
  targetYears: readonly ExporterYear[],
) {
  const warnings: string[] = [];
  const hintedYear = isExporterYear(candidate.acceleratorYearHint)
    ? candidate.acceleratorYearHint
    : null;
  if (
    candidate.acceleratorYearHint !== undefined &&
    candidate.acceleratorYearHint !== null &&
    !hintedYear
  ) {
    return { year: null, reason: "unsupported_year" as const, warnings };
  }
  const focusedText = [
    sourceUrl,
    pageTitle ?? "",
    ...participantAssertions,
  ].join(" ");
  const pageYears = new Set<ExporterYear>();
  const allPageYears = new Set<number>();
  for (const match of focusedText.matchAll(/\b(20\d{2})\b/g)) {
    allPageYears.add(Number(match[1]));
  }
  for (const match of focusedText.matchAll(/\b(2025|2026)\b/g)) {
    pageYears.add(Number(match[1]) as ExporterYear);
  }

  let year: ExporterYear | null = hintedYear;
  if (!year) {
    if (pageYears.size === 1) year = [...pageYears][0];
    else if (pageYears.size > 1) {
      return { year: null, reason: "ambiguous_year" as const, warnings };
    }
  }
  if (!year || !targetYears.includes(year)) {
    return { year: null, reason: "unsupported_year" as const, warnings };
  }

  if (hintedYear && pageYears.size > 0 && !pageYears.has(hintedYear)) {
    return { year: null, reason: "year_conflict" as const, warnings };
  }
  if (hintedYear && allPageYears.size > 0 && !allPageYears.has(hintedYear)) {
    return { year: null, reason: "year_conflict" as const, warnings };
  }
  if (!pageYears.size) {
    if (candidate.origin !== "catalog" && candidate.origin !== "manual") {
      return { year: null, reason: "unsupported_year" as const, warnings };
    }
    warnings.push("The accelerator year is supplied by maintained catalog metadata rather than page markup.");
  }
  return { year, reason: null, warnings };
}

function determineSourceKind(
  candidate: SourceCandidate,
  sourceUrl: string,
  pageTitle: string | null,
  mainText: string,
): ExporterSourceKind | null {
  if (
    candidate.sourceKindHint &&
    EXPORTER_SOURCE_KINDS.includes(candidate.sourceKindHint)
  ) {
    return candidate.sourceKindHint;
  }

  const value = `${sourceUrl} ${pageTitle ?? ""} ${mainText.slice(0, 20_000)}`;
  if (/\bdemo\s+day\b/i.test(value)) return "demo_day";
  if (/\b(?:event|showcase|presenting|pitching)\b/i.test(value)) return "event_page";
  if (/\bpartner\s+(?:accelerator|program|cohort)\b/i.test(value)) return "partner_program";
  if (/\b(?:regional|europe|north\s+america)\s+(?:accelerator|program|cohort)\b/i.test(value)) {
    return "regional_program";
  }
  if (/\b(?:cohort|batch|roster)\b/i.test(value)) return "cohort_roster";
  if (/\b(?:announces?|announcement|selected|welcomes?)\b/i.test(value)) {
    return "announcement";
  }
  return null;
}

function extractPublishedDate($: ReturnType<typeof load>) {
  const explicitValue = cleanText(
    $("meta[property='article:published_time']").attr("content") ??
      $("meta[name='date']").attr("content") ??
      $("time[datetime]").first().attr("datetime"),
  );
  const visibleDatePattern =
    /(?<!\d)(20\d{2})[.\/-](0?[1-9]|1[0-2])[.\/-](0?[1-9]|[12]\d|3[01])(?!\d)/;
  const visibleDate = $("time, p, [class*='date'], [class*='publish']")
    .toArray()
    .map((element) => cleanText($(element).text()).match(visibleDatePattern))
    .find((match): match is RegExpMatchArray => Boolean(match));
  const value =
    explicitValue ||
    (visibleDate
      ? `${visibleDate[1]}-${visibleDate[2].padStart(2, "0")}-${visibleDate[3].padStart(2, "0")}T00:00:00Z`
      : "");
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeTargetYears(values: readonly number[] | undefined) {
  const normalized = (values ?? DEFAULT_TARGET_YEARS).filter(isExporterYear);
  return [...new Set(normalized)] as ExporterYear[];
}

function isExporterYear(value: unknown): value is ExporterYear {
  return value === 2025 || value === 2026;
}

function positiveIntegerOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function cleanNullable(value: string | null | undefined, maxLength: number) {
  const cleaned = cleanText(value).slice(0, maxLength);
  return cleaned || null;
}
