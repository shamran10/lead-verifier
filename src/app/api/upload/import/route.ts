import { importFounderBatch } from "@/lib/import-batch";
import { parseSourceType } from "@/lib/types";
import { parseWorkbook } from "@/lib/workbook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const sourceType = parseSourceType(formData.get("sourceType"));
    const batchNameValue = formData.get("batchName");
    const batchName =
      typeof batchNameValue === "string" ? batchNameValue.trim() : "";

    if (!(file instanceof File)) {
      return Response.json({ error: "Choose an XLSX file." }, { status: 400 });
    }

    if (!sourceType) {
      return Response.json(
        { error: "Choose a valid import source." },
        { status: 400 },
      );
    }

    if (!batchName) {
      return Response.json({ error: "Enter a batch name." }, { status: 400 });
    }

    if (batchName.length > 120) {
      return Response.json(
        { error: "Batch name must be 120 characters or fewer." },
        { status: 400 },
      );
    }

    const parsed = await parseWorkbook(file, sourceType);
    const imported = await importFounderBatch({
      batchName,
      sourceFileName: file.name,
      sourceType,
      founders: parsed.founders,
      invalidRowCount: parsed.invalidRows.length,
    });
    const result = {
      batchId: imported.batchId,
      insertedCount: imported.insertedCount,
      duplicateCount: imported.duplicateCount,
      invalidRowCount: imported.invalidRowCount,
    };

    return Response.json(result, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not import the workbook.";
    return Response.json({ error: message }, { status: 400 });
  }
}
