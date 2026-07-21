import { load } from "cheerio";

import { extractPortfolioDirectory } from "@/lib/antler/extractors/portfolio-directory";
import { extractShowcaseArticle } from "@/lib/antler/extractors/showcase-article";
import {
  extractOfficialIndexCandidates,
  portfolioPaginationCandidates,
} from "@/lib/antler/source-discovery";
import type {
  AntlerSourceCandidate,
  AntlerSourceResult,
  AntlerYear,
} from "@/lib/antler/types";

export function validateAndExtractAntlerSource(input: {
  html: string;
  finalUrl: string;
  candidate: AntlerSourceCandidate;
  targetYears: readonly AntlerYear[];
  fetchedAt: string;
  contentHash: string;
}): AntlerSourceResult {
  if (input.candidate.sourceKind === "portfolio_directory") {
    const extracted = extractPortfolioDirectory(
      input.html,
      input.finalUrl,
      input.targetYears,
    );
    return baseResult(input, {
      status: extracted.companies.length
        ? "validated"
        : extracted.cardCount
          ? "index_processed"
          : "rejected",
      pageTitle: extracted.pageTitle,
      companies: extracted.companies,
      linkedCandidates: portfolioPaginationCandidates(
        extracted.paginationUrls,
        input.finalUrl,
      ),
      rejectionReasons: extracted.cardCount
        ? []
        : ["The portfolio page contained no target-year company cards."],
    });
  }

  if (input.candidate.sourceKind === "insights_index") {
    const $ = load(input.html);
    return baseResult(input, {
      status: "index_processed",
      pageTitle: cleanText($("h1").first().text()) || "Antler Insights",
      companies: [],
      linkedCandidates: extractOfficialIndexCandidates(
        input.html,
        input.finalUrl,
        input.targetYears,
      ),
      rejectionReasons: [],
    });
  }

  const year = resolveYear(input);
  if (!year) {
    return baseResult(input, {
      status: "rejected",
      pageTitle: pageTitle(input.html),
      companies: [],
      linkedCandidates: [],
      rejectionReasons: ["The official page does not establish exactly one requested participation year."],
    });
  }
  const title = pageTitle(input.html);
  const program = input.candidate.programHint ?? title ?? `Antler ${year} participation`;
  const extracted = extractShowcaseArticle({
    html: input.html,
    sourceUrl: input.finalUrl,
    year,
    program,
    sourceKind: input.candidate.sourceKind,
  });
  return baseResult(input, {
    status: extracted.companies.length ? "validated" : "rejected",
    pageTitle: extracted.pageTitle,
    companies: extracted.companies,
    linkedCandidates: [],
    rejectionReasons: extracted.rejectionReasons,
  });
}

function baseResult(
  input: {
    candidate: AntlerSourceCandidate;
    finalUrl: string;
    fetchedAt: string;
    contentHash: string;
  },
  values: {
    status: AntlerSourceResult["status"];
    pageTitle: string | null;
    companies: AntlerSourceResult["companies"];
    linkedCandidates: AntlerSourceResult["linked_candidates"];
    rejectionReasons: string[];
  },
): AntlerSourceResult {
  return {
    candidate: { ...input.candidate, url: input.finalUrl },
    status: values.status,
    final_url: input.finalUrl,
    page_title: values.pageTitle,
    fetched_at: input.fetchedAt,
    content_hash: input.contentHash,
    companies: values.companies,
    linked_candidates: values.linkedCandidates,
    rejection_reasons: values.rejectionReasons,
    warnings: [],
    error: null,
  };
}

function resolveYear(input: {
  html: string;
  candidate: AntlerSourceCandidate;
  targetYears: readonly AntlerYear[];
}) {
  if (
    input.candidate.yearHint &&
    input.targetYears.includes(input.candidate.yearHint)
  ) {
    return input.candidate.yearHint;
  }
  const $ = load(input.html);
  const focus = `${pageTitle(input.html) ?? ""} ${cleanText($("main").first().text())}`;
  const years = input.targetYears.filter((year) =>
    new RegExp(`\\b${year}\\b`).test(focus),
  );
  return years.length === 1 ? years[0] : null;
}

function pageTitle(html: string) {
  const $ = load(html);
  return cleanText(
    $("meta[property='og:title']").attr("content") ?? $("h1").first().text(),
  ) || null;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
