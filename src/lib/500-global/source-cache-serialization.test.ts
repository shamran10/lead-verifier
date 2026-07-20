import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeSerializedSourceCacheValue,
  serializeSourceWorkResultForCache,
} from "@/lib/500-global/source-cache-serialization";

test("source cache serialization allowlists derived metadata and safe companies", () => {
  const sourceUrl = "https://500.co/content/example-2026";
  const runtime = {
    candidate: { url: sourceUrl, origin: "search_provider" },
    status: "validated",
    fetch: {
      finalUrl: sourceUrl,
      status: 200,
      contentType: "text/html",
      contentHash: "abc123",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      redirectCount: 0,
      html: "<!doctype html><html>raw source</html>",
      pageText: "complete page text",
      headers: { authorization: "Bearer private" },
    },
    validation: {
      disposition: "accepted",
      accepted: true,
      source: {
        url: sourceUrl,
        originalUrl: sourceUrl,
        hostname: "500.co",
        sourceKind: "announcement",
        acceleratorYear: 2026,
        acceleratorBatch: "Example",
        pageTitle: "Example participants",
        publishedDate: "2026-01-01T00:00:00.000Z",
        strategies: ["company_cards"],
        participantAssertions: ["full participant section text"],
        expectedMinimumCompanies: 1,
        expectedApproximateCompanies: 1,
        warnings: [],
      },
      reasonCodes: [],
      warnings: [],
      probes: [{
        strategy: "company_cards",
        markerFound: true,
        boundedSectionCount: 1,
        candidateCount: 1,
        confidence: 0.9,
        warnings: [],
      }],
    },
    extraction: {
      source: {
        url: sourceUrl,
        originalUrl: sourceUrl,
        hostname: "500.co",
        sourceKind: "announcement",
        acceleratorYear: 2026,
        acceleratorBatch: "Example",
        pageTitle: "Example participants",
        publishedDate: null,
        strategies: ["company_cards"],
        participantAssertions: ["raw page assertion"],
        expectedMinimumCompanies: 1,
        expectedApproximateCompanies: 1,
        warnings: [],
      },
      participants: [{
        companyName: "Example Co",
        website: "https://example.com/",
        normalizedDomain: "example.com",
        listedCountry: "United States",
        listedCountryEvidence: "company_specific",
        industry: "Software",
        description: "Safe short company description",
        founders: [],
        sourceUrl,
        extractionStrategy: "company_cards",
        evidenceSnippet: "complete source-page snippet",
        warnings: [],
      }],
      strategyResults: [{ html: "<html>raw strategy result</html>" }],
      warnings: [],
    },
    linkedCandidates: [],
    error: null,
    pageText: "complete page text",
    robotsTxt: "User-agent: *",
    braveResponse: { apiKey: "private" },
    sessionToken: "private",
  };

  const serialized = serializeSourceWorkResultForCache(
    runtime,
    () => Date.parse("2026-01-02T00:00:00.000Z"),
  );
  assert.ok(serialized);
  assertSafeSerializedSourceCacheValue(serialized);
  assert.equal(serialized.extraction?.participants[0]?.companyName, "Example Co");
  assert.equal(serialized.extractedParticipantCount, 1);
  const json = JSON.stringify(serialized);
  assert.doesNotMatch(
    json,
    /raw source|complete page text|authorization|private|participantAssertions|evidenceSnippet|strategyResults|robotsTxt|braveResponse|sessionToken/i,
  );
});

test("source cache guard rejects unsafe values that bypass serialization", () => {
  assert.throws(() =>
    assertSafeSerializedSourceCacheValue({
      candidate: { url: "https://500.co/source" },
      status: "failed",
      html: "<html>not safe</html>",
    }),
  );
});
