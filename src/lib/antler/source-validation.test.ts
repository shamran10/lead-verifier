import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { extractPortfolioDirectory } from "@/lib/antler/extractors/portfolio-directory";
import { validateAndExtractAntlerSource } from "@/lib/antler/source-validation";
import type { AntlerSourceCandidate } from "@/lib/antler/types";

const fixtures = path.join(process.cwd(), "src", "lib", "antler", "fixtures");

test("portfolio directory extracts target years and public pagination only", async () => {
  const html = await readFile(path.join(fixtures, "portfolio-directory.html"), "utf8");
  const result = extractPortfolioDirectory(html, "https://www.antler.co/portfolio?0b933bfd_page=1", [2025, 2026]);
  assert.equal(result.cardCount, 2);
  assert.deepEqual(result.companies.map((company) => company.company_name), ["Northstar AI"]);
  assert.equal(result.companies[0]?.participation[0]?.year, 2026);
  assert.deepEqual(result.paginationUrls, ["https://www.antler.co/portfolio?0b933bfd_page=2"]);
});

for (const [fixture, year, expected, founders] of [
  ["showcase-spring-2025.html", 2025, "Helio Works", 2],
  ["showcase-fall-2025.html", 2025, "Orbit Health", 2],
  ["showcase-spring-2026.html", 2026, "Forge Labs", 2],
] as const) {
  test(`${fixture} establishes target-year Antler participation`, async () => {
    const result = validateAndExtractAntlerSource({
      html: await readFile(path.join(fixtures, fixture), "utf8"),
      finalUrl: `https://www.antler.co/blog/${fixture}`,
      candidate: candidate(`https://www.antler.co/blog/${fixture}`, year),
      targetYears: [2025, 2026], fetchedAt: new Date(0).toISOString(), contentHash: "hash",
    });
    assert.equal(result.status, "validated");
    assert.equal(result.companies[0]?.company_name, expected);
    assert.equal(result.companies[0]?.founders.length, founders);
  });
}

test("first-name-only founder remains unaccepted evidence", async () => {
  const result = validateAndExtractAntlerSource({
    html: await readFile(path.join(fixtures, "showcase-fall-2025.html"), "utf8"),
    finalUrl: "https://www.antler.co/blog/fall-2025",
    candidate: candidate("https://www.antler.co/blog/fall-2025", 2025),
    targetYears: [2025], fetchedAt: new Date(0).toISOString(), contentHash: "hash",
  });
  assert.equal(result.companies.find((company) => company.company_name === "Solo Story")?.founders.length, 0);
});

test("generic application/location pages and wrong or historical years return zero", () => {
  for (const html of [
    "<main><h1>Apply to Antler New York in 2026</h1><p>Applications are open.</p></main>",
    "<main><h1>Antler portfolio</h1><p>Companies joined the Antler portfolio in 2024.</p><h2>Old Co: Historical.</h2></main>",
  ]) {
    const result = validateAndExtractAntlerSource({
      html, finalUrl: "https://www.antler.co/blog/example",
      candidate: candidate("https://www.antler.co/blog/example", 2026),
      targetYears: [2025, 2026], fetchedAt: new Date(0).toISOString(), contentHash: "hash",
    });
    assert.equal(result.companies.length, 0);
    assert.equal(result.status, "rejected");
  }
});

function candidate(url: string, year: 2025 | 2026): AntlerSourceCandidate {
  return { url, sourceKind: "showcase", origin: "catalog", discoveredFrom: null,
    yearHint: year, programHint: `Antler ${year}` };
}
