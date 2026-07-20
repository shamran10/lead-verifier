import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { catchAllColumnsForSource } from "@/lib/catch-all-export";
import { smartleadColumnsForSource } from "@/lib/smartlead-export";
import { parseSourceType, sourceTypeLabel } from "@/lib/types";
import { buildBatchInsertPayload } from "@/lib/import-batch";
import { normalizeRedirectTarget } from "@/lib/500-global/safe-fetch";

test("MassChallenge is a distinct labelled source type", () => {
  assert.equal(parseSourceType("masschallenge"), "masschallenge");
  assert.equal(sourceTypeLabel("masschallenge"), "MassChallenge");
});

test("safe fetch preserves a server-required trailing slash across redirects", () => {
  const redirected = normalizeRedirectTarget(
    "/news/2025-cohort/",
    new URL("https://masschallenge.org/news/2025-cohort"),
  );
  assert.equal(redirected.toString(), "https://masschallenge.org/news/2025-cohort/");
  assert.equal(
    normalizeRedirectTarget(redirected.toString(), redirected).toString(),
    redirected.toString(),
  );
});

test("batch import payload stores source_type masschallenge", () => {
  const payload = buildBatchInsertPayload({
    batchName: "MassChallenge 2026",
    sourceFileName: "masschallenge.xlsx",
    sourceType: "masschallenge",
    companyCount: 1,
    founderCount: 1,
    duplicateCount: 0,
  });
  assert.equal(payload.source_type, "masschallenge");
  assert.equal(payload.status, "parsed");
});

test("accelerator exports include metadata while YC columns remain unchanged", () => {
  const legacySmartlead = [...smartleadColumnsForSource("yc")];
  assert.deepEqual(legacySmartlead, [
    "email", "first_name", "last_name", "full_name", "company_name",
    "website", "domain", "linkedin_url", "yc_batch", "industry", "country",
    "source_file", "batch_name", "selected_pattern",
  ]);
  for (const sourceType of ["500_global", "masschallenge"] as const) {
    assert.ok((smartleadColumnsForSource(sourceType) as readonly string[]).includes("accelerator_name"));
    assert.ok((catchAllColumnsForSource(sourceType) as readonly string[]).includes("source_url"));
  }
  assert.equal((catchAllColumnsForSource("yc") as readonly string[]).includes("source_type"), false);
});

test("standalone MassChallenge exporter has no Supabase or Reoon dependency", async () => {
  const files = [
    path.join(process.cwd(), "scripts", "find-masschallenge-leads.ts"),
    ...(await sourceFiles(path.join(process.cwd(), "src", "lib", "masschallenge"))),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:supabase-admin|reoon)["']/i, file);
    assert.doesNotMatch(source, /\b(?:getSupabaseAdmin|verifyEmailWithReoon)\s*\(/, file);
  }
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(target)
      : entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [target]
        : [];
  }));
  return nested.flat();
}
