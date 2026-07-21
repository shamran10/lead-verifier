import assert from "node:assert/strict";
import test from "node:test";

import { enrichStandaloneCompany } from "@/lib/500-global/company-enrichment";
import { filterAntlerCompany, mergeAntlerSourceResults } from "@/lib/antler/pipeline";
import type { AntlerSourceResult, DiscoveredAntlerCompany } from "@/lib/antler/types";

test("duplicate company across directory and showcase retains official associations", () => {
  const directory = source("https://www.antler.co/portfolio", "portfolio_directory", "https://example.com", []);
  const showcase = source("https://www.antler.co/blog/showcase", "showcase", "https://www.example.com/", [{
    founder_name: "Alice Morgan", founder_role: "Founder", linkedin_url: null,
    source_url: "https://www.antler.co/blog/showcase", confidence: 0.9, active_status: "confirmed",
  }]);
  const merged = mergeAntlerSourceResults([directory, showcase]);
  assert.equal(merged.companies.length, 1);
  assert.equal(merged.duplicates.length, 1);
  assert.equal(merged.companies[0]?.participation.length, 2);
  assert.equal(merged.companies[0]?.founders[0]?.founder_name, "Alice Morgan");
});

test("geography classifies outside and unresolved companies conservatively", () => {
  const company = discovered();
  const outside = filterAntlerCompany(company, enrichment("Japan", "JP", null), ["europe", "north_america"]);
  const unresolved = filterAntlerCompany(company, enrichment(null, null, null), ["europe", "north_america"]);
  assert.equal(outside.location_classification, "outside_target_region");
  assert.equal(unresolved.location_classification, "unresolved_location");
});

test("founder enrichment keeps multiple active founders and downgrades former founders", async () => {
  const html = `<main><h1>Team</h1>
    <article><h2>Alice Morgan</h2><p>Founder & CEO</p></article>
    <article><h2>Brian Cole</h2><p>Co-Founder & CTO</p></article>
    <article><h2>Cara Singh</h2><p>Former founder</p></article>
    <article><h2>Daniel</h2><p>Founder</p></article></main>`;
  const result = await enrichStandaloneCompany({
    companyName: "Example", website: "https://example.com", includeFounders: true,
  }, { maxPages: 1, fetchHtml: async () => ({ finalUrl: "https://example.com/", html }) });
  assert.deepEqual(result.activeFounders.map((founder) => founder.name), ["Alice Morgan", "Brian Cole"]);
  assert.equal(result.founders.some((founder) => founder.activeStatus === "former"), true);
  assert.equal(result.activeFounders.some((founder) => founder.name === "Daniel"), false);
});

function source(url: string, kind: "portfolio_directory" | "showcase", website: string, founders: AntlerSourceResult["companies"][number]["founders"]): AntlerSourceResult {
  return { candidate: { url, sourceKind: kind, origin: "catalog", discoveredFrom: null,
    yearHint: 2025, programHint: "Antler 2025" }, status: "validated", final_url: url,
    page_title: "Antler", fetched_at: new Date(0).toISOString(), content_hash: "hash",
    companies: [{ company_name: "Example Co", website, normalized_domain: "example.com",
      listed_location: "United States", listed_location_evidence: "company_specific",
      industry: null, description: null, founders, participation: [{ year: 2025,
        program: "Antler 2025", source_kind: kind, source_url: url }], warnings: [] }],
    linked_candidates: [], rejection_reasons: [], warnings: [], error: null };
}

function discovered(): DiscoveredAntlerCompany {
  return { ...source("https://www.antler.co/portfolio", "portfolio_directory", "https://example.com", []).companies[0]!,
    source_url: "https://www.antler.co/portfolio", additional_source_urls: [], discovery_status: "official_confirmed" };
}

function enrichment(country: string | null, iso2: string | null, region: "europe" | "north_america" | null) {
  return { companyName: "Example Co", website: "https://example.com", canonicalWebsite: "https://example.com/",
    pagesAttempted: [], pages: [], failures: [], locationStatus: country ? "confirmed" as const : "missing" as const,
    headquartersCountry: country, headquartersIso2: iso2, headquartersRegion: region,
    locationEvidence: [], founders: [], activeFounders: [], warnings: [] };
}
