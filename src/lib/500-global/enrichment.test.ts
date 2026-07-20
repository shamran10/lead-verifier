import assert from "node:assert/strict";
import test from "node:test";

import { extractCompanyEnrichmentPage } from "./enrichment";

test("extracts JSON-LD headquarters and an active founder without fetching LinkedIn", () => {
  const result = extractCompanyEnrichmentPage(`
    <html><head><title>About Acme</title>
      <script type="application/ld+json">{
        "@type":"Organization",
        "address":{"@type":"PostalAddress","addressCountry":"U.S.A."}
      }</script>
      <script type="application/ld+json">{
        "@type":"Person",
        "name":"Ada Example",
        "jobTitle":"Founder & CEO",
        "sameAs":"https://www.linkedin.com/in/ada-example?trk=company"
      }</script>
    </head><body><a href="/team">Team</a></body></html>
  `, "https://acme.example/about", "https://acme.example");

  assert.equal(result.headquarters[0]?.country.iso2, "US");
  assert.equal(result.founders[0]?.name, "Ada Example");
  assert.equal(result.founders[0]?.activeStatus, "confirmed");
  assert.equal(result.founders[0]?.linkedinUrl, "https://www.linkedin.com/in/ada-example");
  assert.deepEqual(result.linkedPages, ["https://acme.example/team"]);
});

test("extracts explicit visible headquarters and founder role", () => {
  const result = extractCompanyEnrichmentPage(`
    <html><body>
      <p>Our headquarters are based in Berlin, Germany.</p>
      <section><h2>Grace Hopper</h2><p>Co-Founder & CTO</p></section>
    </body></html>
  `, "https://example.test/about", "https://example.test");
  assert.equal(result.headquarters[0]?.country.iso2, "DE");
  assert.equal(result.founders[0]?.name, "Grace Hopper");
  assert.equal(result.founders[0]?.activeStatus, "confirmed");
});

test("does not classify former founders as active", () => {
  const result = extractCompanyEnrichmentPage(`
    <html><body><section><h2>Alex Former</h2><p>Former Founder and advisor</p></section></body></html>
  `, "https://example.test/team", "https://example.test");
  assert.equal(result.founders[0]?.activeStatus, "former");
});

test("ignores speaker-only names and cross-origin discovery links", () => {
  const result = extractCompanyEnrichmentPage(`
    <html><body>
      <section><h2>Conference Guest</h2><p>Speaker and investor</p></section>
      <a href="https://other.example/team">Other team</a>
    </body></html>
  `, "https://example.test/", "https://example.test");
  assert.equal(result.founders.length, 0);
  assert.equal(result.linkedPages.length, 0);
});
