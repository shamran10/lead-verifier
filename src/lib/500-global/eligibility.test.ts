import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDiscoveryEligibility } from "./eligibility";
import { resolveCountry } from "../geography";

test("country aliases normalize without case or whitespace sensitivity", () => {
  assert.equal(resolveCountry("  U.S.A. ")?.iso2, "US");
  assert.equal(resolveCountry("United States of America")?.region, "north_america");
  assert.equal(resolveCountry(" u.k. ")?.iso2, "GB");
  assert.equal(resolveCountry("Great Britain")?.region, "europe");
  assert.equal(resolveCountry("  japan ")?.region, null);
});

test("confirmed outside-region headquarters is ineligible", () => {
  const result = evaluateDiscoveryEligibility({
    hasUsableDomain: true,
    acceleratorYearAllowed: true,
    sourceApproved: true,
    locationResolution: "confirmed",
    locationRegion: null,
    locationCountry: "Japan",
    targetRegions: ["europe", "north_america"],
    hasEvidenceBackedActiveFounder: false,
  });
  assert.equal(result.status, "ineligible");
  assert.match(result.reasons[0], /outside Europe and North America/i);
});

test("target-region company needs company location and active-founder evidence", () => {
  const provisional = evaluateDiscoveryEligibility({
    hasUsableDomain: true,
    acceleratorYearAllowed: true,
    sourceApproved: true,
    locationResolution: "provisional",
    locationRegion: "europe",
    locationCountry: "France",
    targetRegions: ["europe", "north_america"],
    hasEvidenceBackedActiveFounder: false,
  });
  assert.equal(provisional.status, "needs_review");
  assert.equal(provisional.reasons.length, 2);

  const eligible = evaluateDiscoveryEligibility({
    hasUsableDomain: true,
    acceleratorYearAllowed: true,
    sourceApproved: true,
    locationResolution: "confirmed",
    locationRegion: "north_america",
    locationCountry: "United States",
    targetRegions: ["europe", "north_america"],
    hasEvidenceBackedActiveFounder: true,
  });
  assert.deepEqual(eligible, { status: "eligible", reasons: [] });
});

test("conflicting company and roster locations remain needs review", () => {
  const result = evaluateDiscoveryEligibility({
    hasUsableDomain: true,
    acceleratorYearAllowed: true,
    sourceApproved: true,
    locationResolution: "conflicting",
    locationRegion: "europe",
    locationCountry: "France",
    targetRegions: ["europe", "north_america"],
    hasEvidenceBackedActiveFounder: true,
  });
  assert.equal(result.status, "needs_review");
  assert.match(result.reasons.join(" "), /conflicts/i);
});
