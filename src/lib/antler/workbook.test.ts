import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import readExcelFile from "read-excel-file/node";

import { writeAntlerFinalWorkbook, type AntlerReadyRow } from "@/lib/antler/workbook";
import { parseWorkbook } from "@/lib/workbook-core";

test("Antler workbook round trips and only Ready for Upload is importable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-antler-xlsx-"));
  const outputPath = path.join(root, "Antler.xlsx");
  const ready: AntlerReadyRow[] = [{
    company_name: "Example Co", website: "https://example.com/",
    accelerator_batch: "Antler Spring 2026", accelerator_year: 2026,
    country: "Canada", industry: "Climate", description: "Clean energy",
    founder_name: "Alice Morgan", founder_role: "Founder & CEO", linkedin_url: "",
    founder_2: "Brian Cole", linkedin_url_2: "", founder_3: "", linkedin_url_3: "",
    founder_4: "", linkedin_url_4: "",
    source_url: "https://www.antler.co/blog/spring-2026-showcase",
  }];
  await writeAntlerFinalWorkbook({ outputPath, ready, needsReview: [], unresolved: [], excluded: [], blocked: [] });
  const bytes = await readFile(outputPath);
  const parsed = await parseWorkbook(new File([bytes], "Antler.xlsx"), "antler");
  assert.deepEqual(parsed.processedSheets, ["Ready for Upload"]);
  assert.equal(parsed.founders.length, 2);
  assert.equal(parsed.founders[0]?.acceleratorName, "Antler");
  assert.equal(parsed.founders[0]?.sourceUrl, ready[0]?.source_url);
  const sheets = await readExcelFile(bytes);
  assert.deepEqual(sheets.map((sheet) => sheet.sheet), [
    "Ready for Upload", "Needs Founder Review", "Unresolved Location", "Excluded - Blocked Sources",
  ]);
});

test("Antler parser rejects wrong year, outside country, missing founder, and unofficial URL", async () => {
  const valid = {
    company_name: "Example", website: "https://example.com", accelerator_batch: "Antler",
    accelerator_year: 2026, country: "Canada", founder_name: "Alice Morgan",
    source_url: "https://www.antler.co/blog/example",
  };
  for (const override of [
    { accelerator_year: 2024 }, { country: "Japan" }, { founder_name: "" },
    { source_url: "https://example.org/not-antler" },
  ]) {
    const file = await workbookFile({ ...valid, ...override });
    const parsed = await parseWorkbook(file, "antler");
    assert.equal(parsed.founders.length, 0);
    assert.equal(parsed.invalidRows.length, 1);
  }
});

async function workbookFile(row: Record<string, unknown>) {
  const writeXlsxFile = (await import("write-excel-file/node")).default;
  const root = await mkdtemp(path.join(os.tmpdir(), "fev-antler-parser-"));
  const outputPath = path.join(root, "input.xlsx");
  const headers = Object.keys(row);
  await writeXlsxFile([
    headers.map((value) => ({ value, type: String })),
    headers.map((header) => ({ value: row[header] as string | number, type: typeof row[header] === "number" ? Number : String })),
  ], { filePath: outputPath });
  return new File([await readFile(outputPath)], "input.xlsx");
}
