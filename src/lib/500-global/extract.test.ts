import assert from "node:assert/strict";
import { test } from "node:test";

import { extractOfficialParticipants } from "@/lib/500-global/extract";
import { createPinnedLookup } from "@/lib/500-global/fetch";
import { isRobotsPathAllowed } from "@/lib/500-global/safe-fetch";
import {
  isDiscoveryEvidenceAuthority,
  isDiscoveryEvidenceType,
} from "@/lib/500-global/types";

const COMPANY_NAMES = [
  "Bump", "Bupple", "dromOS", "Echooo AI", "Geeva", "Hypesociety", "InfluSense",
  "Intuition Intelligence", "Kami", "Mindfull", "MoonTech", "Neura Coach", "Noqta Creative",
  "SHAIKE", "Skillstore", "So Squared", "Societiz", "Stareable", "Super Abla",
  "The Good News", "Trenderz",
];

function participantFixture(extraItems = "") {
  const items = COMPANY_NAMES.map(
    (name, index) =>
      `<li><a href="https://company-${index}.example.org">${name}</a> | Software | USA - Example description</li>`,
  ).join("");
  return `<html><head><title>Creators Ventures</title></head><body><div class="broad">Navigation and descendants should not be the marker.<p>The accelerator companies are:</p><ul>${items}${extraItems}</ul></div></body></html>`;
}

test("pinned lookup returns an array when all=true", async () => {
  const lookup = createPinnedLookup([{ address: "8.8.8.8", family: 4 }]);
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    lookup("example.org", { all: true }, (error, result) => {
      if (error) reject(error);
      else if (Array.isArray(result)) resolve(result);
      else reject(new Error("Expected an address array."));
    });
  });
  assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
});

test("pinned lookup returns address and family when all=false", async () => {
  const lookup = createPinnedLookup([{ address: "2606:4700:4700::1111", family: 6 }]);
  const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("example.org", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string" && typeof family === "number") {
        resolve({ address, family });
      } else reject(new Error("Expected one address and family."));
    });
  });
  assert.deepEqual(result, { address: "2606:4700:4700::1111", family: 6 });
});

test("pinned lookup rejects loopback, metadata, and mixed public/private results", () => {
  assert.throws(() => createPinnedLookup([{ address: "127.0.0.1", family: 4 }]));
  assert.throws(() => createPinnedLookup([{ address: "169.254.169.254", family: 4 }]));
  assert.throws(() =>
    createPinnedLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});

test("cached robots text is re-evaluated for every requested path", () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/public`;
  assert.equal(
    isRobotsPathAllowed(
      "https://example.org/public",
      "https://example.org/robots.txt",
      robots,
    ),
    true,
  );
  assert.equal(
    isRobotsPathAllowed(
      "https://example.org/private/company",
      "https://example.org/robots.txt",
      robots,
    ),
    false,
  );
  assert.equal(
    isRobotsPathAllowed(
      "https://example.org/private/public/company",
      "https://example.org/robots.txt",
      robots,
    ),
    true,
  );
});

test("participant-list fixture extracts 21 unique companies with precise diagnostics", () => {
  const result = extractOfficialParticipants(
    participantFixture(),
    "https://500.co/content/creators-ventures-2025",
    {
      strategy: "participant_list",
      expectedMinimumCompanies: 1,
      expectedApproximateCompanies: 21,
    },
  );
  assert.equal(result.participants.length, 21);
  assert.deepEqual(result.diagnostics, {
    marker_found: true,
    candidate_blocks: 1,
    list_items: 21,
    candidate_links: 21,
    accepted_companies: 21,
    ignored_missing_link: 0,
    ignored_empty_name: 0,
    ignored_internal_link: 0,
    ignored_duplicate: 0,
    extractor_strategy: "participant_list",
  });
  assert.deepEqual(result.warnings, []);
});

test("navigation, generic links, and duplicate companies are ignored", () => {
  const html = `<html><body><nav><p>The companies are:</p><ul><li><a href="https://wrong.example.org">Wrong</a></li></ul></nav><main><p>The accelerator companies are:</p><ul><li><a href="https://one.example.org">One</a> | Software | USA - One</li><li><a href="https://one.example.org">One again</a> | Software | USA - Duplicate</li><li><a href="https://500.co/internal">Internal</a></li><li><a href="https://empty.example.org">Learn more</a></li></ul></main></body></html>`;
  const result = extractOfficialParticipants(html, "https://500.co/verified", {
    strategy: "participant_list",
  });
  assert.equal(result.participants.length, 1);
  assert.equal(result.participants[0].companyName, "One");
  assert.equal(result.diagnostics.ignored_duplicate, 1);
  assert.equal(result.diagnostics.ignored_internal_link, 1);
  assert.equal(result.diagnostics.ignored_empty_name, 1);
});

test("a general program page and broad ancestor produce zero companies", () => {
  const result = extractOfficialParticipants(
    `<html><body><div>Our program helps companies and startups worldwide.<ul><li><a href="https://not-a-roster.example.org">Not a roster</a></li></ul></div></body></html>`,
    "https://500.co/program",
    { strategy: "participant_list" },
  );
  assert.equal(result.participants.length, 0);
  assert.equal(result.diagnostics.marker_found, false);
});

test("only the deployed evidence authority value passes validation", () => {
  assert.equal(isDiscoveryEvidenceAuthority("500_global_official"), true);
  assert.equal(isDiscoveryEvidenceAuthority("500 Global"), false);
  assert.equal(isDiscoveryEvidenceAuthority("official"), false);
});

test("evidence types match the deployed constraint", () => {
  for (const value of [
    "official_membership",
    "accelerator_year",
    "accelerator_batch",
    "company_website",
    "headquarters",
    "founder_identity",
    "founder_role",
    "linkedin_url",
  ]) {
    assert.equal(isDiscoveryEvidenceType(value), true);
  }
  assert.equal(isDiscoveryEvidenceType("official_participant_listing"), false);
  assert.equal(isDiscoveryEvidenceType("participant_listing"), false);
});

test("founders in a shared paragraph attach to the next company reference", () => {
  const html = `<html><body><p>The companies are:</p><ul><li><a href="https://usebump.com">Bump</a> | Software | USA - One</li><li><a href="https://readkami.com">Kami</a> | Software | Turkey - Two</li></ul><p>Founded by <a href="https://linkedin.com/in/james">James Jones</a>, founder of <a href="https://usebump.com">Bump</a>, and <a href="https://linkedin.com/in/yagmur">Yağmur Aydemir</a>, founder of <a href="https://readkami.com">Kami</a>.</p></body></html>`;
  const result = extractOfficialParticipants(
    html,
    "https://500.co/content/creators-ventures-2025",
    { strategy: "participant_list" },
  );
  const bump = result.participants.find((company) => company.companyName === "Bump");
  const kami = result.participants.find((company) => company.companyName === "Kami");
  assert.deepEqual(bump?.founders.map((founder) => founder.name), ["James Jones"]);
  assert.deepEqual(kami?.founders.map((founder) => founder.name), ["Yağmur Aydemir"]);
  assert.deepEqual(result.warnings, []);
});
