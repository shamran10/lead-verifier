import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { SourceCandidate } from "@/lib/500-global/exporter-types";
import {
  extractValidatedParticipants,
  validateAndExtractParticipantSource,
  validateParticipantSource,
} from "@/lib/500-global/source-validation";

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function candidate(
  url: string,
  overrides: Partial<SourceCandidate> = {},
): SourceCandidate {
  return {
    url,
    origin: "catalog",
    sourceKindHint: "announcement",
    acceleratorYearHint: 2025,
    ...overrides,
  };
}

test("validates and extracts the bounded 21-company Creators Ventures list", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-creators-ventures.html"),
    candidate("https://500.co/content/creators-ventures-2025", {
      acceleratorYearHint: 2026,
      acceleratorBatchHint: "Creators Ventures Accelerator",
      strategyHints: ["participant_list"],
      expectedApproximateCompanies: 21,
    }),
  );

  assert.equal(result.validation.accepted, true);
  assert.equal(result.validation.source?.acceleratorYear, 2026);
  assert.equal(result.extraction?.participants.length, 21);
  assert.equal(result.extraction?.warnings.length, 0);
  const bump = result.extraction?.participants.find(
    (participant) => participant.companyName === "Bump",
  );
  assert.equal(bump?.normalizedDomain, "usebump.com");
  assert.equal(bump?.listedCountry, "United States");
  assert.equal(bump?.listedCountryEvidence, "company_specific");
  assert.equal(bump?.founders[0]?.founderName, "James Jones");
});

test("company-card extraction stays inside the participant section", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-company-cards.html"),
    candidate("https://500.co/content/2025-company-cohort", {
      sourceKindHint: "cohort_roster",
      strategyHints: ["company_cards"],
    }),
  );

  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((participant) => participant.companyName),
    ["Alpine Grid", "Maple Health"],
  );
  assert.equal(
    result.extraction?.participants.some(
      (participant) => participant.companyName === "Navigation Corp",
    ),
    false,
  );
  assert.equal(
    result.extraction?.participants.some(
      (participant) => participant.companyName === "Speaker Person",
    ),
    false,
  );
});

test("a same-paragraph official founder profile attaches only to its linked roster company", () => {
  const html = `<!doctype html><html><head><title>500 Global 2026 Cohort</title></head><body><main>
    <h2>The accelerator companies are:</h2><ul>
      <li><a href="https://usebump.com">Bump</a> | Fintech | USA - Creator finance.</li>
      <li><a href="https://readkami.com">Kami</a> | Consumer | Turkey - Story platform.</li>
    </ul><p>Moving to the final stage are
      <a href="https://www.linkedin.com/in/james-jones?tracking=ignored">James Jones</a>,
      CEO &amp; Co-founder of creator fintech platform <a href="https://usebump.com">Bump</a>, and
      <a href="https://www.linkedin.com/in/yagmur-aydemir">Yağmur Aydemir</a>,
      CEO &amp; Founder of story platform <a href="https://readkami.com">Kami</a>.
    </p></main></body></html>`;
  const result = validateAndExtractParticipantSource(
    html,
    candidate("https://500.co/content/current-cohort-2026", {
      acceleratorYearHint: 2026,
      strategyHints: ["participant_list"],
    }),
  );
  const bump = result.extraction?.participants.find(
    (participant) => participant.companyName === "Bump",
  );
  const kami = result.extraction?.participants.find(
    (participant) => participant.companyName === "Kami",
  );
  assert.equal(bump?.founders[0]?.founderName, "James Jones");
  assert.match(bump?.founders[0]?.founderRole ?? "", /co-founder/i);
  assert.equal(
    bump?.founders[0]?.linkedinUrl,
    "https://www.linkedin.com/in/james-jones",
  );
  assert.equal(kami?.founders[0]?.founderName, "Yağmur Aydemir");
});

test("extracts bounded spotlight companies", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-spotlight.html"),
    candidate("https://500.co/content/2026-company-spotlights", {
      acceleratorYearHint: 2026,
      strategyHints: ["spotlight_sections"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((participant) => participant.companyName),
    ["Ledger Bloom", "Ruta Norte"],
  );
});

test("demo-day extraction rejects speakers and sponsors", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-demo-day.html"),
    candidate("https://events.500.co/2025-demo-day", {
      sourceKindHint: "demo_day",
      strategyHints: ["demo_day_sections"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((participant) => participant.companyName),
    ["Forge Robot", "Vistula Secure"],
  );
});

test("accessible logo extraction requires useful accessible company names", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-logo-links.html"),
    candidate("https://500.co/content/selected-ventures-2026", {
      acceleratorYearHint: 2026,
      strategyHints: ["accessible_logo_links"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((participant) => participant.companyName),
    ["Clearwater Labs", "Nordic Pixel"],
  );
});

test("placeholder-heavy participant events produce zero companies and are rejected", () => {
  const validation = validateParticipantSource(
    fixture("source-placeholder-event.html"),
    candidate("https://events.500.co/placeholder-event-2025", {
      sourceKindHint: "event_page",
      strategyHints: ["company_cards", "accessible_logo_links"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("no_extractable_participants"), true);
});

test("general application pages cannot become participant sources", () => {
  const validation = validateParticipantSource(
    fixture("source-general-application.html"),
    candidate("https://500.co/programs/apply-2025", {
      sourceKindHint: "regional_program",
      strategyHints: ["participant_list", "company_cards"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("application_only"), true);
  assert.equal(validation.reasonCodes.includes("no_participant_assertion"), true);
});

test("a historical portfolio directory is not cohort membership evidence", () => {
  const validation = validateParticipantSource(
    fixture("source-historical-portfolio.html"),
    candidate("https://500.co/portfolio/2025", {
      sourceKindHint: "manual_catalog",
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("historical_portfolio"), true);
});

test("malformed HTML remains bounded and safely extractable", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-malformed.html"),
    candidate("https://500.co/content/cohort-2026", {
      acceleratorYearHint: 2026,
      sourceKindHint: "cohort_roster",
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.companyName, "Resilient Markup");
});

test("rejects non-HTTPS, unapproved, and out-of-scope-year sources", () => {
  const html = fixture("source-company-cards.html");
  assert.deepEqual(
    validateParticipantSource(
      html,
      candidate("http://500.co/content/cohort-2025", {
        strategyHints: ["company_cards"],
      }),
    ).reasonCodes,
    ["invalid_url"],
  );
  assert.deepEqual(
    validateParticipantSource(
      html,
      candidate("https://unapproved.example/cohort-2025", {
        strategyHints: ["company_cards"],
      }),
    ).reasonCodes,
    ["unapproved_host"],
  );
  assert.equal(
    validateParticipantSource(
      html,
      candidate("https://500.co/content/cohort-2024", {
        acceleratorYearHint: 2024,
        strategyHints: ["company_cards"],
      }),
    ).reasonCodes.includes("unsupported_year"),
    true,
  );
});

test("approved partner hosts still require explicit 500 Global attribution", () => {
  const html = fixture("source-company-cards.html");
  const accepted = validateParticipantSource(
    html,
    candidate("https://accelerator.partner.example/cohort-2025", {
      sourceKindHint: "partner_program",
      strategyHints: ["company_cards"],
    }),
    { approvedPartnerHosts: ["partner.example"] },
  );
  assert.equal(accepted.accepted, true);

  const missingAttribution = validateParticipantSource(
    html.replaceAll("500 Global", "Partner Accelerator"),
    candidate("https://accelerator.partner.example/cohort-2025", {
      sourceKindHint: "partner_program",
      strategyHints: ["company_cards"],
    }),
    { approvedPartnerHosts: ["partner.example"] },
  );
  assert.equal(missingAttribution.accepted, false);
  assert.equal(
    missingAttribution.reasonCodes.includes("missing_500_global_attribution"),
    true,
  );
});

test("domain-first merging deduplicates strategies but keeps equal names on distinct domains", () => {
  const html = `<!doctype html><html><head><title>500 Global 2025 Cohort</title></head><body>
    <section><h2>Meet the selected companies in the 2025 cohort</h2>
      <article class="company-card"><h3>Same Name</h3><a href="https://one.example" aria-label="Same Name"><img alt="Same Name"></a></article>
      <article class="company-card"><h3>Same Name</h3><a href="https://two.example">Website</a></article>
    </section></body></html>`;
  const validation = validateParticipantSource(
    html,
    candidate("https://500.co/content/domain-first-2025", {
      strategyHints: ["company_cards", "accessible_logo_links"],
    }),
  );
  assert.equal(validation.accepted, true);
  const extraction = extractValidatedParticipants(html, validation.source!);
  assert.equal(extraction.participants.length, 2);
  assert.deepEqual(
    extraction.participants.map((participant) => participant.normalizedDomain),
    ["one.example", "two.example"],
  );
});

test("expected participant counts become coverage warnings, not invented rows", () => {
  const result = validateAndExtractParticipantSource(
    fixture("source-company-cards.html"),
    candidate("https://500.co/content/cohort-2025", {
      strategyHints: ["company_cards"],
      expectedMinimumCompanies: 4,
      expectedApproximateCompanies: 5,
    }),
  );
  assert.equal(result.extraction?.participants.length, 2);
  assert.equal(result.extraction?.warnings.length, 2);
});

test("a generic Companies heading is not an explicit membership assertion", () => {
  const html = `<!doctype html><html><head><title>500 Global 2025</title></head><body>
    <section><h2>Companies</h2><article class="company-card"><h3>Generic Co</h3>
    <a href="https://generic.example">Website</a></article></section></body></html>`;
  const validation = validateParticipantSource(
    html,
    candidate("https://500.co/content/generic-companies-2025", {
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("no_participant_assertion"), true);
});

test("year hints conflict safely and ambiguous pages need review", () => {
  const html = fixture("source-company-cards.html");
  const conflict = validateParticipantSource(
    html.replaceAll("2025", "2026"),
    candidate("https://500.co/content/cohort-2026", {
      acceleratorYearHint: 2025,
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reasonCodes.includes("year_conflict"), true);

  const ambiguous = validateParticipantSource(
    html.replace("2025", "2025 and 2026"),
    candidate("https://500.co/content/cohort", {
      acceleratorYearHint: null,
      origin: "official_index",
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.reasonCodes.includes("ambiguous_year"), true);
});

test("a maintained 2026 source may retain a stale 2025 URL slug when the visible publication date confirms 2026", () => {
  const html = `<!doctype html><html><head><title>500 Global Creators Ventures</title></head><body>
    <main><p>2026.01.15</p><section><h2>The accelerator companies are:</h2>
      <article class="company-card"><h3>Current Cohort Company</h3>
      <a href="https://current-cohort.example">Website</a></article>
    </section></main></body></html>`;
  const validation = validateParticipantSource(
    html,
    candidate("https://500.co/content/creators-ventures-2025", {
      acceleratorYearHint: 2026,
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(validation.accepted, true);
  assert.equal(validation.source?.acceleratorYear, 2026);
  assert.equal(validation.source?.publishedDate, "2026-01-15T00:00:00.000Z");
});

test("program location outside a company card never becomes company country", () => {
  const html = `<!doctype html><html><head><title>500 Global 2025 Cohort</title></head><body>
    <p>Program headquarters: Singapore</p>
    <section><h2>Meet the selected companies in the 2025 cohort</h2>
      <article class="company-card"><h3>Location Safe</h3>
      <a href="https://location-safe.example">Website</a></article>
    </section></body></html>`;
  const result = validateAndExtractParticipantSource(
    html,
    candidate("https://500.co/content/location-safe-2025", {
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.listedCountry, null);
});

test("known structured data requires a visible participant assertion and bounded ItemList", () => {
  const html = `<!doctype html><html><head><title>500 Global 2026 Cohort</title></head><body>
    <h2>Meet the selected companies in the 2026 cohort</h2>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      name: "Selected companies",
      itemListElement: [{
        "@type": "ListItem",
        item: {
          "@type": "Organization",
          name: "Structured Labs",
          url: "https://structured.example",
          address: { "@type": "PostalAddress", addressCountry: "Canada" },
          founder: {
            "@type": "Person",
            name: "Ada Structured",
            jobTitle: "Founder & CEO",
            sameAs: "https://www.linkedin.com/in/ada-structured",
          },
        },
      }],
    })}</script></body></html>`;
  const result = validateAndExtractParticipantSource(
    html,
    candidate("https://500.co/content/structured-cohort-2026", {
      acceleratorYearHint: 2026,
      strategyHints: ["known_structured_data"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.companyName, "Structured Labs");
  assert.equal(result.extraction?.participants[0]?.listedCountry, "Canada");
  assert.equal(
    result.extraction?.participants[0]?.listedCountryEvidence,
    "company_specific",
  );
  assert.equal(result.extraction?.participants[0]?.founders[0]?.founderName, "Ada Structured");
});

test("template Company Name cards are never participants", () => {
  const html = `<!doctype html><html><head><title>500 Global 2025 Demo Day</title></head><body>
    <section><h2>Meet the presenting companies at Demo Day 2025</h2>
      <article class="company-card"><h3>Company Name</h3><p>Company summary goes here.</p></article>
    </section></body></html>`;
  const validation = validateParticipantSource(
    html,
    candidate("https://events.500.co/template-demo-2025", {
      sourceKindHint: "demo_day",
      strategyHints: ["company_cards"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("no_extractable_participants"), true);
});

test("recognizes bounded Splash-style company cards inside official program rosters", () => {
  const html = `<!doctype html><html><head><title>500 Eurasia Batch 9 Demo Day</title></head><body>
    <section><h2>Meet Batch 9 Startups</h2>
      <div class="speaker-card"><h3>AdMagica.ai</h3><p>AI ad creative platform.</p><a href="https://admagica.example">Website</a></div>
      <div class="speaker-card"><h3>Callsy AI</h3><p>AI voice commerce platform.</p><a href="https://callsy.example">Website</a></div>
    </section>
    <section><h2>Speakers</h2><div class="speaker-card"><h3>Example Speaker</h3></div></section>
  </body></html>`;
  const result = validateAndExtractParticipantSource(
    html,
    candidate("https://events.500.co/500eurasiab9dd/website", {
      sourceKindHint: "demo_day",
      strategyHints: ["company_cards", "spotlight_sections"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.deepEqual(
    result.extraction?.participants.map((participant) => participant.companyName),
    ["AdMagica.ai", "Callsy AI"],
  );
});

test("extracts bounded participant records from embedded application JSON", () => {
  const html = `<!doctype html><html><head><title>500 Global 2026 Cohort</title></head><body>
    <h2>Meet the selected companies in the 2026 cohort</h2>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { companies: [{
        companyName: "Embedded North",
        website: "https://embedded.example",
        country: "Canada",
        founders: [{ founderName: "Ada Embedded", role: "Founder & CEO" }],
      }] } },
    })}</script>
  </body></html>`;
  const result = validateAndExtractParticipantSource(
    html,
    candidate("https://500.co/content/embedded-cohort-2026", {
      acceleratorYearHint: 2026,
      strategyHints: ["known_structured_data"],
    }),
  );
  assert.equal(result.validation.accepted, true);
  assert.equal(result.extraction?.participants[0]?.companyName, "Embedded North");
  assert.equal(result.extraction?.participants[0]?.listedCountry, "Canada");
  assert.equal(result.extraction?.participants[0]?.founders[0]?.founderName, "Ada Embedded");
});

test("infers supported current source kinds when no catalog kind hint is present", () => {
  const scenarios = [
    ["500 Global 2025 Demo Day presenting companies", "demo_day"],
    ["Meet the selected 2025 cohort companies", "cohort_roster"],
    ["500 Global regional accelerator selected startups", "regional_program"],
    ["500 Global partner program selected startups", "partner_program"],
    ["500 Global startup showcase event presenting companies", "event_page"],
  ] as const;
  for (const [heading, expectedKind] of scenarios) {
    const html = `<!doctype html><html><head><title>${heading}</title></head><body><section>
      <h2>${heading}</h2><article class="company-card"><h3>Current Company</h3>
      <a href="https://current.example">Website</a></article></section></body></html>`;
    const result = validateParticipantSource(
      html,
      candidate(`https://500.co/content/${expectedKind}-2025`, {
        sourceKindHint: null,
        strategyHints: ["company_cards"],
      }),
    );
    assert.equal(result.accepted, true, expectedKind);
    assert.equal(result.source?.sourceKind, expectedKind);
  }
});

test("explicit historical publication dates override current search hints and footer years", () => {
  const html = `<!doctype html><html><head><title>Global Launch Batch 2 Companies</title></head><body><main>
    <p class="published-date">2020.11.02</p>
    <section><h2>Global Launch Batch 2 Companies</h2><ul>
      <li><a href="https://historical.example">Historical Company</a></li>
    </ul></section></main><footer>Copyright © 2025 500 Global</footer></body></html>`;
  const validation = validateParticipantSource(
    html,
    candidate("https://500.co/content/historical-global-launch", {
      origin: "search_provider",
      acceleratorYearHint: 2025,
      sourceKindHint: "cohort_roster",
      strategyHints: ["participant_list"],
    }),
  );
  assert.equal(validation.accepted, false);
  assert.equal(validation.reasonCodes.includes("unsupported_year"), true);
});
