import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTechstarsRosterLocation,
  resolveTechstarsRosterLocation,
} from "@/lib/techstars/roster-location";

test("resolves company-level US city/state roster locations", () => {
  for (const value of [
    "New York, NY",
    "Los Angeles, CA",
    "Louisville, KY",
    "San Francisco, CA",
    "Brooklyn, NY",
  ]) {
    const result = resolveTechstarsRosterLocation(value);
    assert.equal(result?.canonicalCountry, "United States", value);
    assert.equal(result?.region, "north_america", value);
    assert.equal(result?.matchedBy, "us_state", value);
  }
});

test("resolves Canadian province and explicit city/country roster locations", () => {
  const calgary = resolveTechstarsRosterLocation("Calgary, AB, Canada");
  assert.equal(calgary?.canonicalCountry, "Canada");
  assert.equal(calgary?.region, "north_america");
  assert.equal(calgary?.matchedBy, "canadian_province");

  const london = resolveTechstarsRosterLocation("London, United Kingdom");
  assert.equal(london?.canonicalCountry, "United Kingdom");
  assert.equal(london?.region, "europe");
  assert.equal(london?.matchedBy, "city_country");
});

test("extracts a leading participant location but rejects program names and city-only values", () => {
  const result = extractTechstarsRosterLocation(
    "(New York, NY): Company-specific product description.",
  );
  assert.equal(result?.listedLocation, "New York, NY");
  assert.equal(resolveTechstarsRosterLocation("Techstars London"), null);
  assert.equal(resolveTechstarsRosterLocation("New York"), null);
});
