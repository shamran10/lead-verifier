import { classifyFounders, findExistingFounderKeys } from "@/lib/founder-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ImportResult } from "@/lib/types";
import { parseWorkbook } from "@/lib/workbook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let createdBatchId: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const batchNameValue = formData.get("batchName");
    const batchName =
      typeof batchNameValue === "string" ? batchNameValue.trim() : "";

    if (!(file instanceof File)) {
      return Response.json({ error: "Choose an XLSX file." }, { status: 400 });
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

    const parsed = await parseWorkbook(file);
    const existingKeys = await findExistingFounderKeys(parsed.founders);
    const classified = classifyFounders(parsed.founders, existingKeys);
    const uniqueFounders = classified.filter(
      (founder) => founder.status === "ready",
    );
    const duplicateCount = classified.length - uniqueFounders.length;
    const companyCount = new Set(
      uniqueFounders.map(
        (founder) => `${founder.companyName}\u0000${founder.normalizedDomain}`,
      ),
    ).size;
    const supabase = getSupabaseAdmin();

    const { data: batch, error: batchError } = await supabase
      .from("fev_batches")
      .insert({
        batch_name: batchName,
        source_file_name: file.name.slice(0, 255),
        status: "parsed",
        total_companies: companyCount,
        total_founders: uniqueFounders.length,
        duplicate_founders: duplicateCount,
        valid_emails: 0,
        no_valid_emails: 0,
      })
      .select("id")
      .single();

    if (batchError || !batch) {
      throw new Error(
        `Could not create the batch: ${batchError?.message ?? "Unknown error"}`,
      );
    }

    createdBatchId = batch.id;

    if (uniqueFounders.length > 0) {
      const { error: foundersError } = await supabase.from("fev_founders").insert(
        uniqueFounders.map((founder) => ({
          batch_id: batch.id,
          source_sheet_name: founder.sourceSheetName,
          source_row: founder.sourceRow,
          company_name: founder.companyName,
          website: founder.website,
          normalized_domain: founder.normalizedDomain,
          yc_batch: founder.ycBatch,
          industry: founder.industry,
          description: founder.description,
          country: founder.country,
          founder_name: founder.founderName,
          normalized_founder_name: founder.normalizedFounderName,
          first_name: founder.firstName,
          last_name: founder.lastName,
          linkedin_url: founder.linkedinUrl,
          first_candidate_email: founder.firstCandidateEmail,
          last_candidate_email: founder.lastCandidateEmail,
          status: "pending",
        })),
      );

      if (foundersError) {
        throw new Error(`Could not insert founders: ${foundersError.message}`);
      }
    }

    const result: ImportResult = {
      batchId: batch.id,
      insertedCount: uniqueFounders.length,
      duplicateCount,
      invalidRowCount: parsed.invalidRows.length,
    };

    return Response.json(result, { status: 201 });
  } catch (error) {
    if (createdBatchId) {
      const supabase = getSupabaseAdmin();
      await supabase.from("fev_batches").delete().eq("id", createdBatchId);
    }

    const message =
      error instanceof Error ? error.message : "Could not import the workbook.";
    return Response.json({ error: message }, { status: 400 });
  }
}
