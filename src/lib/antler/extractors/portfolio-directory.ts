import { load } from "cheerio";

import { normalizeAntlerSourceUrl } from "@/lib/antler/source-policy";
import type {
  AntlerYear,
  ExtractedAntlerCompany,
} from "@/lib/antler/types";
import { normalizeDomain } from "@/lib/founder-normalization";

export function extractPortfolioDirectory(
  html: string,
  sourceUrl: string,
  targetYears: readonly AntlerYear[],
) {
  const $ = load(html);
  const companies: ExtractedAntlerCompany[] = [];

  $(".portco_card").each((_, element) => {
    const card = $(element);
    const companyName = cleanText(
      card.find('[fs-cmsfilter-field="name"]').first().text(),
    );
    const description = cleanText(
      card.find('[fs-cmsfilter-field="description"]').first().text(),
    );
    const tags = card
      .find(".tag_small_text")
      .toArray()
      .map((tag) => cleanText($(tag).text()));
    const year = Number(tags.at(-1));
    if (!companyName || !isTargetYear(year, targetYears)) return;

    const websiteValue = card.find("a.clickable_link[href]").first().attr("href");
    const website = normalizeExternalWebsite(websiteValue, sourceUrl);
    const country = tags[0] || null;
    const industry = tags.length >= 3 ? tags[1] || null : null;
    companies.push({
      company_name: companyName,
      website,
      normalized_domain: website ? normalizeDomain(website) : null,
      listed_location: country,
      listed_location_evidence: country ? "company_specific" : null,
      industry,
      description: description || null,
      founders: [],
      participation: [
        {
          year,
          program: "Antler Portfolio Directory",
          source_kind: "portfolio_directory",
          source_url: sourceUrl,
        },
      ],
      warnings: website ? [] : ["The Antler portfolio card has no usable company website."],
    });
  });

  const paginationUrls = $("a[href*='0b933bfd_page']")
    .toArray()
    .map((anchor) => $(anchor).attr("href"))
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeAntlerSourceUrl(value, sourceUrl))
    .filter((value, index, values) => values.indexOf(value) === index);

  return {
    pageTitle: cleanText($("h1").first().text()) || "Antler Portfolio Directory",
    cardCount: $(".portco_card").length,
    companies,
    paginationUrls,
  };
}

function isTargetYear(
  value: number,
  targetYears: readonly AntlerYear[],
): value is AntlerYear {
  return (value === 2025 || value === 2026) && targetYears.includes(value);
}

function normalizeExternalWebsite(value: string | undefined, baseUrl: string) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      url.protocol !== "https:" ||
      !hostname ||
      hostname === "antler.co" ||
      hostname.endsWith(".antler.co") ||
      hostname === "linkedin.com" ||
      hostname.endsWith(".linkedin.com")
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
