import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMPANY_ENRICHMENT_MAX_PAGES,
  enrichStandaloneCompany,
  extractStandaloneCompanyPage,
  type CompanyEnrichmentFetcher,
} from "./company-enrichment";

function fixture(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

test("prefers actual same-origin company links, checks at most five pages, and never fetches LinkedIn", async () => {
  const calls: string[] = [];
  const fetchHtml: CompanyEnrichmentFetcher = async (url) => {
    calls.push(url);
    const pathname = new URL(url).pathname;
    const html =
      pathname === "/"
        ? fixture("company-home.html")
        : pathname === "/our-story"
          ? fixture("company-about.html")
          : pathname === "/leadership"
            ? fixture("company-team.html")
            : pathname === "/contact-us"
              ? fixture("company-no-headquarters.html")
              : fixture("company-malformed.html");
    return {
      finalUrl: url,
      html,
      contentHash: `hash-${calls.length}`,
      fetchedAt: "2026-07-18T00:00:00.000Z",
    };
  };

  const result = await enrichStandaloneCompany(
    {
      companyName: "Example Company",
      website: "example.test",
      listedCountry: "USA",
    },
    { fetchHtml },
  );

  assert.equal(calls.length, COMPANY_ENRICHMENT_MAX_PAGES);
  assert.deepEqual(
    calls.slice(0, 4).map((url) => new URL(url).pathname),
    ["/", "/our-story", "/leadership", "/contact-us"],
  );
  assert.equal(calls.some((url) => url.includes("linkedin.com")), false);
  assert.equal(calls.some((url) => url.includes("unrelated.example")), false);
  assert.equal(result.locationStatus, "confirmed");
  assert.equal(result.headquartersIso2, "US");
  assert.equal(result.activeFounders.length, 4);
  assert.equal(result.activeFounders[0]?.linkedinUrl, "https://www.linkedin.com/in/ada-north");
  assert.match(result.warnings.join(" "), /more than four active founders/i);
});

test("extracts confirmed, possible, and former founders only from their logical profile containers", () => {
  const page = extractStandaloneCompanyPage(
    fixture("company-team.html"),
    "https://example.test/leadership",
    "https://example.test",
  );

  assert.equal(page.founders.filter((founder) => founder.activeStatus === "confirmed").length, 5);
  assert.equal(
    page.founders.find((founder) => founder.name === "Frank Former")?.activeStatus,
    "former",
  );
  assert.equal(
    page.founders.find((founder) => founder.name === "Gina Guest")?.activeStatus,
    "possible",
  );
  assert.equal(page.founders.some((founder) => founder.name === "Hank Employee"), false);
  assert.equal(
    page.founders.find((founder) => founder.name === "Ada North")?.linkedinUrl,
    "https://www.linkedin.com/in/ada-north",
  );
});

test("uses only explicit or structured headquarters evidence and treats multiple company countries as conflicting", async () => {
  const result = await enrichStandaloneCompany(
    {
      companyName: "Conflict Company",
      website: "https://conflict.test",
      listedCountry: "France",
    },
    {
      fetchHtml: async (url) => ({
        finalUrl: url,
        html: fixture("company-conflicting.html"),
      }),
    },
  );

  assert.equal(result.locationStatus, "conflicting");
  assert.equal(result.headquartersCountry, null);
  assert.deepEqual(
    new Set(
      result.locationEvidence
        .filter((evidence) => evidence.authority === "company_official")
        .map((evidence) => evidence.country.iso2),
    ),
    new Set(["FR", "CA"]),
  );
  assert.match(result.warnings.join(" "), /conflicts/i);
});

test("a clearly company-specific official roster country confirms current location", async () => {
  const result = await enrichStandaloneCompany(
    {
      companyName: "Roster Located Company",
      website: null,
      listedCountry: "United States of America",
      listedCountryEvidence: "company_specific",
      officialSourceUrl: "https://500.co/content/official-cohort",
    },
    {
      fetchHtml: async () => {
        throw new Error("A missing website must not trigger a fetch.");
      },
    },
  );
  assert.equal(result.locationStatus, "confirmed");
  assert.equal(result.headquartersCountry, "United States");
  assert.equal(result.locationEvidence[0]?.authority, "500_global_official");
});

test("does not infer headquarters from office addresses, customer markets, or employee roles", () => {
  const page = extractStandaloneCompanyPage(
    fixture("company-no-headquarters.html"),
    "https://example.test/contact",
    "https://example.test",
  );
  assert.deepEqual(page.headquarters, []);
  assert.deepEqual(page.founders, []);
});

test("returns a resumable needs-review result when every company page is inaccessible and sanitizes failures", async () => {
  const calls: string[] = [];
  const result = await enrichStandaloneCompany(
    {
      companyName: "Unavailable Company",
      website: "https://unavailable.test",
    },
    {
      fetchHtml: async (url) => {
        calls.push(url);
        throw new Error("Bearer super-secret-token request failed");
      },
    },
  );

  assert.equal(calls.length, COMPANY_ENRICHMENT_MAX_PAGES);
  assert.equal(result.pages.length, 0);
  assert.equal(result.locationStatus, "missing");
  assert.equal(result.activeFounders.length, 0);
  assert.match(result.warnings.join(" "), /could not be fetched/i);
  assert.equal(JSON.stringify(result).includes("super-secret-token"), false);
  assert.match(result.failures[0]?.reason ?? "", /\[redacted\]/);
});

test("malformed HTML and invalid structured data produce diagnostics without throwing", () => {
  const page = extractStandaloneCompanyPage(
    fixture("company-malformed.html"),
    "https://example.test/about",
    "https://example.test",
  );
  assert.equal(page.headquarters.length, 0);
  assert.equal(page.founders.length, 0);
  assert.equal(page.linkedPages.length, 0);
});

test("official roster founders remain provisional inputs and conflicting active-status evidence is not auto-confirmed", async () => {
  const result = await enrichStandaloneCompany(
    {
      companyName: "Founder Conflict",
      website: null,
      sourceFounders: [
        {
          name: "Alex Example",
          role: "Founder & CEO",
          linkedinUrl: "https://linkedin.com/in/alex-example?source=roster",
          sourceUrl: "https://500.co/content/cohort",
        },
        {
          name: "Alex Example",
          role: "Former Founder",
          sourceUrl: "https://500.co/content/update",
        },
      ],
    },
    {
      fetchHtml: async () => {
        throw new Error("Fetcher should not be called without a website.");
      },
    },
  );

  assert.equal(result.founders[0]?.activeStatus, "possible");
  assert.equal(result.activeFounders.length, 0);
  assert.equal(
    result.founders[0]?.linkedinUrl,
    "https://www.linkedin.com/in/alex-example",
  );
  assert.match(result.warnings.join(" "), /active-status evidence conflicts/i);
});

test("an active founder bio may say previously without being classified as former", () => {
  const extracted = extractStandaloneCompanyPage(
    `<!doctype html><html><body><section><article class="profile">
      <h3>Ada Lovelace</h3><p>Founder &amp; CEO, previously at Example Corp</p>
    </article></section></body></html>`,
    "https://company.example/team",
    "https://company.example",
  );
  assert.equal(extracted.founders[0]?.name, "Ada Lovelace");
  assert.equal(extracted.founders[0]?.activeStatus, "confirmed");
});

test("Retry-After failures stop fallback crawling and remain resumable", async () => {
  let calls = 0;
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  const result = await enrichStandaloneCompany(
    { companyName: "Rate Limited", website: "https://rate.example" },
    {
      fetchHtml: async () => {
        calls += 1;
        const error = Object.assign(new Error("Rate limited"), {
          kind: "retry",
          retryAt,
        });
        throw error;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.failures[0]?.retryable, true);
  assert.equal(result.failures[0]?.retryAt, retryAt);
  assert.match(result.warnings.join(" "), /Retry-After/i);
});

test("uses organization JSON-LD legal location and founder declarations without a job title", () => {
  const jsonLd = {
    "@type": "Organization",
    name: "Structured Company",
    legalAddress: {
      "@type": "PostalAddress",
      addressCountry: "United Kingdom",
    },
    founder: {
      "@type": "Person",
      name: "Ada North",
      sameAs: ["https://www.linkedin.com/in/ada-north"],
    },
  };
  const page = extractStandaloneCompanyPage(
    `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>
      <a href="/founders">Founders</a></body></html>`,
    "https://structured.example/",
    "https://structured.example",
  );
  assert.equal(page.headquarters[0]?.country.iso2, "GB");
  assert.equal(page.founders[0]?.name, "Ada North");
  assert.equal(page.founders[0]?.activeStatus, "confirmed");
  assert.equal(page.linkedPages[0], "https://structured.example/founders");
});
