import "server-only";

import { randomUUID } from "node:crypto";

import { load, type CheerioAPI } from "cheerio";

import { evaluateDiscoveryEligibility, type LocationResolution } from "@/lib/500-global/eligibility";
import { fetchCompanyEnrichmentHtml } from "@/lib/500-global/fetch";
import {
  getDiscoveryEnrichmentProgress,
  recordDiscoveryEventOnce,
  recalculateCompanyEligibility,
  refreshDiscoveryRunCounters,
  requireRun,
} from "@/lib/500-global/repository";
import {
  DiscoveryError,
  type DiscoveryEnrichmentNextResult,
  type DiscoveryEvidenceAuthority,
  type DiscoveryEvidenceType,
  type DiscoveryFounderActiveStatus,
} from "@/lib/500-global/types";
import type { Database, Json } from "@/lib/database.types";
import { normalizeFounderName } from "@/lib/founder-normalization";
import { resolveCountry, type RecognizedCountry } from "@/lib/geography";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const COMPANY_AUTHORITY: DiscoveryEvidenceAuthority = "company_official";
const ROSTER_AUTHORITY: DiscoveryEvidenceAuthority = "500_global_official";
const LEASE_MS = 3 * 60 * 1000;
const MAX_PAGES = 5;
const PAGE_PATHS = ["/about", "/team", "/company", "/contact"] as const;

type CompanyRow = Database["public"]["Tables"]["fev_500global_discovered_companies"]["Row"];

export type ExtractedHeadquarters = {
  country: RecognizedCountry;
  snippet: string;
  confidence: number;
};

export type ExtractedCompanyFounder = {
  name: string;
  role: string;
  linkedinUrl: string | null;
  activeStatus: DiscoveryFounderActiveStatus;
  snippet: string;
};

export type CompanyPageExtraction = {
  pageTitle: string | null;
  linkedPages: string[];
  headquarters: ExtractedHeadquarters[];
  founders: ExtractedCompanyFounder[];
};

export async function processNextCompanyEnrichment(
  runId: string,
): Promise<DiscoveryEnrichmentNextResult> {
  const run = await requireRun(runId);
  if (run.imported_batch_id || run.status === "completed") {
    throw new DiscoveryError("Imported discovery runs cannot be enriched.", 409);
  }
  if (run.status === "paused") {
    return enrichmentResult(runId, "paused", "Company enrichment is paused.");
  }

  await prepareEnrichmentQueue(runId);
  await reclaimExpiredCompanyLeases(runId);
  const company = await reserveNextCompany(runId);
  if (!company) {
    const progress = await getDiscoveryEnrichmentProgress(runId);
    return {
      outcome: progress.pendingCompanies ? "idle" : "complete",
      message: progress.pendingCompanies
        ? "Another request is processing the next company."
        : "Headquarters and founder checks are complete.",
      progress,
    };
  }

  try {
    await enrichReservedCompany(runId, company);
    await recordDiscoveryEventOnce(
      runId,
      "company_enriched",
      "Company-owned pages were checked for headquarters and active founders.",
      { companyId: company.id },
    );
  } catch (error) {
    const safeMessage = sanitizeOperationalError(error);
    const supabase = getSupabaseAdmin();
    await supabase
      .from("fev_500global_discovered_companies")
      .update({
        enrichment_status: "error",
        lease_token: null,
        lease_expires_at: null,
        last_error: safeMessage,
      })
      .eq("id", company.id)
      .eq("lease_token", company.lease_token ?? "");
    await recordDiscoveryEventOnce(
      runId,
      "company_enrichment_failed",
      "A company could not be enriched automatically.",
      {
        companyId: company.id,
        level: "warning",
        details: { reason: safeMessage },
      },
    );
  }
  await refreshDiscoveryRunCounters(runId);
  return enrichmentResult(runId, "processed", "One company was checked.");
}

export async function prepareEnrichmentQueue(runId: string) {
  const run = await requireRun(runId);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_discovered_companies")
    .select("*")
    .eq("run_id", runId);
  if (error) throw new DiscoveryError("Could not prepare company enrichment.", 500);

  for (const company of data ?? []) {
    if (company.imported_batch_id || company.import_status === "imported") continue;
    const summary = jsonObject(company.evidence_summary);
    const manuallyConfirmed = summary.location_resolution === "manual_confirmed";
    const rosterCountry = resolveCountry(
      stringValue(summary.roster_country) ?? company.headquarters_country ?? "",
    );
    if (rosterCountry) {
      await insertEvidenceOnce({
        runId,
        sourceId: company.primary_source_id,
        companyId: company.id,
        founderId: null,
        evidenceType: "headquarters",
        authority: ROSTER_AUTHORITY,
        evidenceUrl: company.source_url,
        pageTitle: null,
        snippet: `Official participant roster lists the company location as ${rosterCountry.canonicalName}.`,
        observedValue: rosterCountry.canonicalName,
        normalizedValue: rosterCountry.iso2,
        supportsClaim: true,
        confidence: rosterCountry.region ? 0.7 : 0.85,
        contentHash: null,
        observedAt: company.created_at,
      });
    }
    if (manuallyConfirmed || company.review_status !== "pending") continue;

    const locationResolution: LocationResolution = rosterCountry
      ? rosterCountry.region
        ? "provisional"
        : "confirmed"
      : "missing";
    const eligibility = evaluateDiscoveryEligibility({
      hasUsableDomain: Boolean(company.normalized_domain),
      acceleratorYearAllowed: Boolean(
        company.accelerator_year && run.target_years.includes(company.accelerator_year),
      ),
      sourceApproved: true,
      locationResolution,
      locationRegion: rosterCountry?.region ?? null,
      locationCountry: rosterCountry?.canonicalName ?? company.headquarters_country,
      targetRegions: run.target_regions,
      hasEvidenceBackedActiveFounder: false,
    });
    const nextEnrichmentStatus =
      eligibility.status === "ineligible"
        ? "skipped"
        : company.enrichment_attempts === 0 && company.enrichment_status !== "processing"
          ? "pending"
          : company.enrichment_status;
    const nextSummary: Json = {
      ...summary,
      roster_country: rosterCountry?.canonicalName ?? company.headquarters_country,
      roster_country_iso2: rosterCountry?.iso2 ?? null,
      location_resolution: locationResolution,
    };
    const { error: updateError } = await supabase
      .from("fev_500global_discovered_companies")
      .update({
        headquarters_country: rosterCountry?.canonicalName ?? company.headquarters_country,
        headquarters_iso2: rosterCountry?.iso2 ?? company.headquarters_iso2,
        accelerator_region: rosterCountry?.region ?? null,
        eligibility_status: eligibility.status,
        eligibility_reasons: eligibility.reasons,
        enrichment_status: nextEnrichmentStatus,
        evidence_summary: nextSummary,
        ...(eligibility.status === "ineligible"
          ? { review_status: "pending" as const, import_status: "not_ready" as const }
          : {}),
      })
      .eq("id", company.id)
      .eq("review_status", "pending");
    if (updateError) throw new DiscoveryError("Could not reconcile roster geography.", 500);
  }
  await refreshDiscoveryRunCounters(runId);
}

async function reserveNextCompany(runId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_500global_discovered_companies")
    .select("*")
    .eq("run_id", runId)
    .eq("review_status", "pending")
    .eq("import_status", "not_ready")
    .eq("enrichment_status", "pending")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new DiscoveryError("Could not load the next company for enrichment.", 500);

  for (const candidate of data ?? []) {
    const leaseToken = randomUUID();
    const { data: reserved, error: reserveError } = await supabase
      .from("fev_500global_discovered_companies")
      .update({
        enrichment_status: "processing",
        enrichment_attempts: candidate.enrichment_attempts + 1,
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
        last_error: null,
      })
      .eq("id", candidate.id)
      .eq("enrichment_status", "pending")
      .is("lease_token", null)
      .select("*")
      .maybeSingle();
    if (reserveError) throw new DiscoveryError("Could not reserve a company for enrichment.", 500);
    if (reserved) return reserved;
  }
  return null;
}

async function reclaimExpiredCompanyLeases(runId: string) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .update({
      enrichment_status: "pending",
      lease_token: null,
      lease_expires_at: null,
      last_error: "An expired enrichment lease was safely re-queued.",
    })
    .eq("run_id", runId)
    .eq("enrichment_status", "processing")
    .lt("lease_expires_at", now);
  if (error) throw new DiscoveryError("Could not reclaim expired company enrichment.", 500);
}

async function enrichReservedCompany(runId: string, company: CompanyRow) {
  if (!company.website || !company.normalized_domain) {
    throw new DiscoveryError("The company website is missing or unusable.", 409);
  }
  const home = new URL(company.website);
  home.protocol = "https:";
  home.pathname = "/";
  home.search = "";
  home.hash = "";
  const queue = [home.toString()];
  const seen = new Set<string>();
  const pages: Array<{
    url: string;
    title: string | null;
    contentHash: string;
    observedAt: string;
    extraction: CompanyPageExtraction;
  }> = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const fetched = await fetchCompanyEnrichmentHtml(url, home.toString(), {
        runId,
        sourceId: company.primary_source_id,
      });
      const extraction = extractCompanyEnrichmentPage(fetched.html, fetched.finalUrl, home.toString());
      pages.push({
        url: fetched.finalUrl,
        title: extraction.pageTitle,
        contentHash: fetched.contentHash,
        observedAt: fetched.fetchedAt,
        extraction,
      });
      if (pages.length === 1) {
        for (const linked of extraction.linkedPages) {
          if (!seen.has(linked) && queue.length + pages.length < MAX_PAGES) queue.push(linked);
        }
        for (const path of PAGE_PATHS) {
          const fallback = new URL(path, home).toString();
          if (!seen.has(fallback) && !queue.includes(fallback) && queue.length + pages.length < MAX_PAGES) {
            queue.push(fallback);
          }
        }
      }
    } catch (error) {
      if (!pages.length) throw error;
    }
  }
  if (!pages.length) throw new DiscoveryError("No company-owned page could be checked.", 502);

  for (const page of pages) {
    await insertEvidenceOnce({
      runId,
      sourceId: null,
      companyId: company.id,
      founderId: null,
      evidenceType: "company_website",
      authority: COMPANY_AUTHORITY,
      evidenceUrl: page.url,
      pageTitle: page.title,
      snippet: "Company-owned page fetched for public headquarters and founder evidence.",
      observedValue: company.normalized_domain,
      normalizedValue: company.normalized_domain,
      supportsClaim: true,
      confidence: 1,
      contentHash: page.contentHash,
      observedAt: page.observedAt,
    });
  }

  const headquarters = pages
    .flatMap((page) => page.extraction.headquarters.map((item) => ({ ...item, page })))
    .sort((left, right) => right.confidence - left.confidence)[0];
  const summary = jsonObject(company.evidence_summary);
  const rosterCountry = resolveCountry(stringValue(summary.roster_country) ?? company.headquarters_country ?? "");
  let locationResolution = (stringValue(summary.location_resolution) as LocationResolution | null) ?? "missing";
  let headquartersCountry = company.headquarters_country;
  let headquartersIso2 = company.headquarters_iso2;
  let acceleratorRegion = company.accelerator_region;
  const warnings = [...company.warnings];

  if (headquarters) {
    const conflicts = Boolean(rosterCountry && rosterCountry.iso2 !== headquarters.country.iso2);
    locationResolution = conflicts ? "conflicting" : "confirmed";
    if (conflicts) {
      warnings.push(
        `Company-owned location evidence (${headquarters.country.canonicalName}) conflicts with the official roster (${rosterCountry?.canonicalName}).`,
      );
    } else {
      headquartersCountry = headquarters.country.canonicalName;
      headquartersIso2 = headquarters.country.iso2;
      acceleratorRegion = headquarters.country.region;
    }
    await insertEvidenceOnce({
      runId,
      sourceId: null,
      companyId: company.id,
      founderId: null,
      evidenceType: "headquarters",
      authority: COMPANY_AUTHORITY,
      evidenceUrl: headquarters.page.url,
      pageTitle: headquarters.page.title,
      snippet: headquarters.snippet,
      observedValue: headquarters.country.canonicalName,
      normalizedValue: headquarters.country.iso2,
      supportsClaim: true,
      confidence: headquarters.confidence,
      contentHash: headquarters.page.contentHash,
      observedAt: headquarters.page.observedAt,
    });
  }

  let insertedFounders = 0;
  if (!(locationResolution === "confirmed" && !acceleratorRegion)) {
    for (const page of pages) {
      for (const founder of page.extraction.founders) {
        insertedFounders += await upsertCompanyFounder(runId, company, founder, page);
      }
    }
  }

  const nextSummary: Json = {
    ...summary,
    location_resolution: locationResolution,
    company_location_country: headquarters?.country.canonicalName ?? null,
    company_location_iso2: headquarters?.country.iso2 ?? null,
    enriched_page_count: pages.length,
    founders_found: insertedFounders,
  };
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("fev_500global_discovered_companies")
    .update({
      headquarters_country: headquartersCountry,
      headquarters_iso2: headquartersIso2,
      accelerator_region: acceleratorRegion,
      evidence_summary: nextSummary,
      warnings: [...new Set(warnings)],
      enrichment_status: "enriched",
      enriched_at: new Date().toISOString(),
      lease_token: null,
      lease_expires_at: null,
      last_error: null,
    })
    .eq("id", company.id)
    .eq("lease_token", company.lease_token ?? "");
  if (error) throw new DiscoveryError("Could not save company enrichment.", 500);
  await recalculateCompanyEligibility(runId, company.id);
}

async function upsertCompanyFounder(
  runId: string,
  company: CompanyRow,
  founder: ExtractedCompanyFounder,
  page: { url: string; title: string | null; contentHash: string; observedAt: string },
) {
  const normalized = normalizeFounderName(founder.name);
  if (!normalized) return 0;
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("fev_500global_discovered_founders")
    .select("*")
    .eq("company_id", company.id)
    .eq("normalized_founder_name", normalized.normalizedFounderName)
    .limit(1)
    .maybeSingle();
  if (existingError) throw new DiscoveryError("Could not inspect discovered founders.", 500);
  let founderId = existing?.id ?? null;
  if (!founderId) {
    const { data: inserted, error } = await supabase
      .from("fev_500global_discovered_founders")
      .insert({
        company_id: company.id,
        founder_name: founder.name.slice(0, 200),
        normalized_founder_name: normalized.normalizedFounderName,
        first_name: normalized.firstName,
        last_name: normalized.lastName,
        founder_role: founder.role.slice(0, 120),
        linkedin_url: founder.linkedinUrl,
        active_status: founder.activeStatus,
        review_status: "pending",
        duplicate_status: "unchecked",
        import_status: "not_ready",
        include_in_import: false,
        warnings: ["Founder identity and active status require operator review before import."],
        evidence_summary: { company_official_url: page.url },
      })
      .select("id")
      .single();
    if (error || !inserted) throw new DiscoveryError("Could not store an enriched founder.", 500);
    founderId = inserted.id;
  } else if (
    existing &&
    existing.review_status === "pending" &&
    existing.import_status !== "imported"
  ) {
    await supabase
      .from("fev_500global_discovered_founders")
      .update({
        founder_role: founder.role.slice(0, 120),
        linkedin_url: existing.linkedin_url ?? founder.linkedinUrl,
        active_status: founder.activeStatus,
      })
      .eq("id", existing.id)
      .eq("review_status", "pending");
  }

  await insertEvidenceOnce({
    runId,
    sourceId: null,
    companyId: company.id,
    founderId,
    evidenceType: "founder_identity",
    authority: COMPANY_AUTHORITY,
    evidenceUrl: page.url,
    pageTitle: page.title,
    snippet: founder.snippet,
    observedValue: founder.name,
    normalizedValue: normalized.normalizedFounderName,
    supportsClaim: true,
    confidence: founder.activeStatus === "confirmed" ? 0.9 : 0.65,
    contentHash: page.contentHash,
    observedAt: page.observedAt,
  });
  await insertEvidenceOnce({
    runId,
    sourceId: null,
    companyId: company.id,
    founderId,
    evidenceType: "founder_role",
    authority: COMPANY_AUTHORITY,
    evidenceUrl: page.url,
    pageTitle: page.title,
    snippet: founder.snippet,
    observedValue: founder.role,
    normalizedValue: founder.role.toLowerCase(),
    supportsClaim: true,
    confidence: founder.activeStatus === "confirmed" ? 0.9 : 0.65,
    contentHash: page.contentHash,
    observedAt: page.observedAt,
  });
  if (founder.linkedinUrl) {
    await insertEvidenceOnce({
      runId,
      sourceId: null,
      companyId: company.id,
      founderId,
      evidenceType: "linkedin_url",
      authority: COMPANY_AUTHORITY,
      evidenceUrl: page.url,
      pageTitle: page.title,
      snippet: "Public LinkedIn URL linked directly from the company-owned page.",
      observedValue: founder.linkedinUrl,
      normalizedValue: founder.linkedinUrl.toLowerCase(),
      supportsClaim: true,
      confidence: 0.9,
      contentHash: page.contentHash,
      observedAt: page.observedAt,
    });
  }
  return existing ? 0 : 1;
}

type EvidenceInput = {
  runId: string;
  sourceId: string | null;
  companyId: string;
  founderId: string | null;
  evidenceType: DiscoveryEvidenceType;
  authority: DiscoveryEvidenceAuthority;
  evidenceUrl: string;
  pageTitle: string | null;
  snippet: string;
  observedValue: string;
  normalizedValue: string;
  supportsClaim: boolean;
  confidence: number;
  contentHash: string | null;
  observedAt: string;
};

async function insertEvidenceOnce(input: EvidenceInput) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("fev_500global_evidence")
    .select("id")
    .eq("run_id", input.runId)
    .eq("company_id", input.companyId)
    .eq("evidence_type", input.evidenceType)
    .eq("authority", input.authority)
    .eq("evidence_url", input.evidenceUrl)
    .eq("normalized_value", input.normalizedValue);
  query = input.sourceId ? query.eq("source_id", input.sourceId) : query.is("source_id", null);
  query = input.founderId ? query.eq("founder_id", input.founderId) : query.is("founder_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new DiscoveryError("Could not inspect enrichment evidence.", 500);
  if (data) return data.id;
  const { data: inserted, error: insertError } = await supabase
    .from("fev_500global_evidence")
    .insert({
      run_id: input.runId,
      source_id: input.sourceId,
      company_id: input.companyId,
      founder_id: input.founderId,
      evidence_type: input.evidenceType,
      authority: input.authority,
      evidence_url: input.evidenceUrl,
      page_title: input.pageTitle,
      snippet: input.snippet.slice(0, 1000),
      observed_value: input.observedValue.slice(0, 500),
      normalized_value: input.normalizedValue.slice(0, 500),
      supports_claim: input.supportsClaim,
      confidence: input.confidence,
      content_hash: input.contentHash,
      observed_at: input.observedAt,
    })
    .select("id")
    .single();
  if (insertError || !inserted) throw new DiscoveryError("Could not store enrichment evidence.", 500);
  return inserted.id;
}

export function extractCompanyEnrichmentPage(
  html: string,
  pageUrl: string,
  companyUrl: string,
): CompanyPageExtraction {
  const $ = load(html);
  const headquarters = extractJsonLdHeadquarters($);
  const founders = extractJsonLdFounders($, pageUrl);
  $("script, style, noscript, template, svg").remove();
  headquarters.push(...extractVisibleHeadquarters($));
  founders.push(...extractVisibleFounders($, pageUrl));
  return {
    pageTitle: cleanText($("meta[property='og:title']").attr("content") ?? $("title").first().text()).slice(0, 500) || null,
    linkedPages: extractCompanyPageLinks($, pageUrl, companyUrl),
    headquarters: dedupeHeadquarters(headquarters),
    founders: dedupeFounders(founders),
  };
}

function extractJsonLdHeadquarters($: CheerioAPI) {
  const results: ExtractedHeadquarters[] = [];
  for (const value of jsonLdValues($)) {
    visitJson(value, (node) => {
      const type = stringArray(node["@type"]);
      if (!type.some((item) => /organization|corporation|business/i.test(item))) return;
      const address = objectValue(node.address);
      const rawCountry = stringValue(address?.addressCountry);
      const country = rawCountry ? resolveCountry(rawCountry) : null;
      if (country) {
        results.push({
          country,
          snippet: `Organization JSON-LD lists address country as ${country.canonicalName}.`,
          confidence: 0.95,
        });
      }
    });
  }
  return results;
}

function extractJsonLdFounders($: CheerioAPI, pageUrl: string) {
  const results: ExtractedCompanyFounder[] = [];
  for (const value of jsonLdValues($)) {
    visitJson(value, (node) => {
      const type = stringArray(node["@type"]);
      if (!type.some((item) => /person/i.test(item))) return;
      const name = stringValue(node.name);
      const role = stringValue(node.jobTitle) ?? "";
      if (!name || !isFounderRole(role)) return;
      results.push({
        name,
        role,
        linkedinUrl: normalizeLinkedInUrl(stringValue(node.sameAs), pageUrl),
        activeStatus: founderActiveStatus(`${name} ${role}`),
        snippet: cleanText(`${name} — ${role}`).slice(0, 500),
      });
    });
  }
  return results;
}

function extractVisibleHeadquarters($: CheerioAPI) {
  const results: ExtractedHeadquarters[] = [];
  $("address, p, li, div").each((_, element) => {
    const text = cleanText($(element).text());
    if (!text || text.length > 500) return;
    const explicit = /\b(headquarters|headquartered|hq|based\s+in)\b/i.test(text);
    if (!explicit && element.tagName !== "address") return;
    const country = countryFromText(text);
    if (country) {
      results.push({
        country,
        snippet: text.slice(0, 500),
        confidence: explicit ? 0.9 : 0.78,
      });
    }
  });
  return results;
}

function extractVisibleFounders($: CheerioAPI, pageUrl: string) {
  const results: ExtractedCompanyFounder[] = [];
  $("article, li, section, div").each((_, element) => {
    const container = $(element);
    const text = cleanText(container.text());
    if (!text || text.length > 700 || !isFounderRole(text)) return;
    const role = container
      .find("p, span, small, h1, h2, h3, h4, h5")
      .toArray()
      .map((item) => cleanText($(item).text()))
      .filter((item) => item.length <= 180 && isFounderRole(item))
      .sort((left, right) => left.length - right.length)[0] ?? text;
    const name = container
      .find("h1, h2, h3, h4, h5, strong")
      .toArray()
      .map((item) => cleanText($(item).text()))
      .find((item) => item.length >= 3 && item.length <= 120 && Boolean(normalizeFounderName(item)));
    if (!name) return;
    const linkedinHref = container.find("a[href*='linkedin.com']").first().attr("href") ?? null;
    results.push({
      name,
      role: role.slice(0, 120),
      linkedinUrl: normalizeLinkedInUrl(linkedinHref, pageUrl),
      activeStatus: founderActiveStatus(`${name} ${role} ${text}`),
      snippet: text.slice(0, 500),
    });
  });
  return results;
}

function extractCompanyPageLinks($: CheerioAPI, pageUrl: string, companyUrl: string) {
  const expected = companyHostKey(new URL(companyUrl));
  const links: string[] = [];
  $("a[href]").each((_, element) => {
    try {
      const url = new URL($(element).attr("href") ?? "", pageUrl);
      if (url.protocol !== "https:" || companyHostKey(url) !== expected) return;
      url.hash = "";
      url.search = "";
      const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
      if (!PAGE_PATHS.some((candidate) => path === candidate || path.endsWith(candidate))) return;
      url.pathname = path;
      const normalized = url.toString();
      if (!links.includes(normalized)) links.push(normalized);
    } catch {
      // Ignore malformed links.
    }
  });
  return links.slice(0, MAX_PAGES - 1);
}

function countryFromText(text: string) {
  const segments = text
    .replace(/[()]/g, ",")
    .split(/[,|•—–]/)
    .map((item) => cleanText(item.replace(/[.;:]+$/g, "")))
    .filter(Boolean);
  for (const segment of segments.reverse()) {
    const direct = segment.length === 2 ? null : resolveCountry(segment);
    if (direct) return direct;
    const words = segment.split(/\s+/);
    for (let length = Math.min(5, words.length); length >= 1; length -= 1) {
      const candidate = words.slice(-length).join(" ").replace(/[.;:]+$/g, "");
      if (candidate.length === 2) continue;
      const country = resolveCountry(candidate);
      if (country) return country;
    }
  }
  return null;
}

function isFounderRole(value: string) {
  return /\b(?:co[\s-]?founder|founder)\b/i.test(value);
}

function founderActiveStatus(value: string): DiscoveryFounderActiveStatus {
  if (/\b(former|ex[\s-]?founder|previously|alumni)\b/i.test(value)) return "former";
  if (/\b(advisor|mentor|investor|speaker)\b/i.test(value)) return "possible";
  return "confirmed";
}

function normalizeLinkedInUrl(value: unknown, baseUrl: string) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, baseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || hostname !== "linkedin.com" || !url.pathname.startsWith("/in/")) return null;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeHeadquarters(values: ExtractedHeadquarters[]) {
  const byCountry = new Map<string, ExtractedHeadquarters>();
  for (const value of values) {
    const current = byCountry.get(value.country.iso2);
    if (!current || value.confidence > current.confidence) byCountry.set(value.country.iso2, value);
  }
  return [...byCountry.values()];
}

function dedupeFounders(values: ExtractedCompanyFounder[]) {
  const byName = new Map<string, ExtractedCompanyFounder>();
  for (const value of values) {
    const normalized = normalizeFounderName(value.name)?.normalizedFounderName;
    if (!normalized) continue;
    const current = byName.get(normalized);
    if (!current || activeRank(value.activeStatus) > activeRank(current.activeStatus)) byName.set(normalized, value);
  }
  return [...byName.values()];
}

function activeRank(value: DiscoveryFounderActiveStatus) {
  return value === "confirmed" ? 3 : value === "possible" ? 2 : value === "former" ? 1 : 0;
}

function jsonLdValues($: CheerioAPI) {
  const values: unknown[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      values.push(JSON.parse($(element).text()));
    } catch {
      // Ignore malformed structured data.
    }
  });
  return values;
}

function visitJson(value: unknown, visitor: (node: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  visitor(object);
  for (const nested of Object.values(object)) visitJson(nested, visitor);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
}

function jsonObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : {};
}

function companyHostKey(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeOperationalError(error: unknown) {
  const message = error instanceof Error ? error.message : "Company enrichment failed.";
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi, "$1[redacted]")
    .slice(0, 300);
}

async function enrichmentResult(
  runId: string,
  outcome: DiscoveryEnrichmentNextResult["outcome"],
  message: string,
): Promise<DiscoveryEnrichmentNextResult> {
  return { outcome, message, progress: await getDiscoveryEnrichmentProgress(runId) };
}
