import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildBatchInsertPayload } from "@/lib/import-batch";
import { parseSourceType, sourceTypeLabel } from "@/lib/types";

test("Antler source type, label, and import payload are connected", () => {
  assert.equal(parseSourceType("antler"), "antler");
  assert.equal(sourceTypeLabel("antler"), "Antler");
  const payload = buildBatchInsertPayload({ batchName: "Antler", sourceFileName: "antler.xlsx",
    sourceType: "antler", companyCount: 1, founderCount: 1, duplicateCount: 0 });
  assert.equal(payload.source_type, "antler");
});

test("standalone Antler exporter has no Supabase or Reoon dependency", async () => {
  const files = [path.join(process.cwd(), "scripts", "find-antler-leads.ts"),
    ...(await collectFiles(path.join(process.cwd(), "src", "lib", "antler"))).filter((file) => !file.endsWith(".test.ts"))];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /supabase|reoon/i, file);
  }
});

async function collectFiles(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await collectFiles(value));
    else if (entry.name.endsWith(".ts")) values.push(value);
  }
  return values;
}
