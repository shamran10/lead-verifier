import { classifyFounders, findExistingFounderKeys } from "@/lib/founder-data";
import type { PreviewResult } from "@/lib/types";
import { parseWorkbook } from "@/lib/workbook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "Choose an XLSX file." }, { status: 400 });
    }

    const parsed = await parseWorkbook(file);
    const existingKeys = await findExistingFounderKeys(parsed.founders);
    const founders = classifyFounders(parsed.founders, existingKeys);
    const readyFounders = founders.filter((founder) => founder.status === "ready");
    const companyCount = new Set(
      readyFounders.map(
        (founder) => `${founder.companyName}\u0000${founder.normalizedDomain}`,
      ),
    ).size;

    const result: PreviewResult = {
      founders,
      companyCount,
      founderCount: founders.length,
      readyCount: readyFounders.length,
      duplicateCount: founders.length - readyFounders.length,
      invalidRowCount: parsed.invalidRows.length,
      invalidRows: parsed.invalidRows,
      processedSheets: parsed.processedSheets,
      skippedSheets: parsed.skippedSheets,
    };

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not preview the workbook.";
    return Response.json({ error: message }, { status: 400 });
  }
}
