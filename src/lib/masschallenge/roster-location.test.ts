import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMassChallengeRosterLocation,
  resolveMassChallengeRosterLocation,
} from "@/lib/masschallenge/roster-location";

test("resolves company-level US city/state roster locations", () => {
  for (const value of [
    "New York, NY",
    "Los Angeles, CA",
    "Louisville, KY",
    "San Francisco, CA",
    "Brooklyn, NY",
  ]) {
    const result = resolveMassChallengeRosterLocation(value);
    assert.equal(result?.canonicalCountry, "United States", value);
    assert.equal(result?.region, "north_america", value);
    assert.equal(result?.matchedBy, "us_state", value);
  }
});

test("resolves Canadian province and explicit city/country roster locations", () => {
  const calgary = resolveMassChallengeRosterLocation("Calgary, AB, Canada");
  assert.equal(calgary?.canonicalCountry, "Canada");
  assert.equal(calgary?.region, "north_america");
  assert.equal(calgary?.matchedBy, "canadian_province");

  const london = resolveMassChallengeRosterLocation("London, United Kingdom");
  assert.equal(london?.canonicalCountry, "United Kingdom");
  assert.equal(london?.region, "europe");
  assert.equal(london?.matchedBy, "city_country");
});

test("extracts a leading participant location but rejects program names and city-only values", () => {
  const result = extractMassChallengeRosterLocation(
    "(New York, NY): Company-specific product description.",
  );
  assert.equal(result?.listedLocation, "New York, NY");
  assert.equal(resolveMassChallengeRosterLocation("MassChallenge London"), null);
  assert.equal(resolveMassChallengeRosterLocation("New York"), null);
});
