import "server-only";

import { classifyFounders, findExistingFounderKeys } from "@/lib/founder-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ImportResult, ParsedFounder, SourceType } from "@/lib/types";

export type ImportFounderBatchInput = {
  batchName: string;
  sourceFileName: string;
  sourceType: SourceType;
  founders: ParsedFounder[];
  invalidRowCount?: number;
  discoveryRunId?: string | null;
};

export type ImportFounderBatchResult = ImportResult & {
  reusedExistingBatch: boolean;
};

export function buildBatchInsertPayload(input: {
  batchName: string;
  sourceFileName: string;
  sourceType: SourceType;
  discoveryRunId?: string | null;
  companyCount: number;
  founderCount: number;
  duplicateCount: number;
}) {
  return {
    batch_name: input.batchName,
    source_file_name: input.sourceFileName,
    source_type: input.sourceType,
    discovery_run_id: input.discoveryRunId ?? null,
    status: "parsed" as const,
    total_companies: input.companyCount,
    total_founders: input.founderCount,
    duplicate_founders: input.duplicateCount,
    valid_emails: 0,
    no_valid_emails: 0,
  };
}

export async function importFounderBatch(
  input: ImportFounderBatchInput,
): Promise<ImportFounderBatchResult> {
  const batchName = input.batchName.trim();
  if (!batchName) throw new Error("Enter a batch name.");
  if (batchName.length > 120) {
    throw new Error("Batch name must be 120 characters or fewer.");
  }

  const sourceFileName = input.sourceFileName.trim().slice(0, 255);
  if (!sourceFileName) throw new Error("A source file name is required.");

  const supabase = getSupabaseAdmin();
  if (input.discoveryRunId) {
    const existing = await findDiscoveryBatch(input.discoveryRunId);
    if (existing) {
      return {
        batchId: existing.id,
        insertedCount: existing.total_founders,
        duplicateCount: existing.duplicate_founders,
        invalidRowCount: input.invalidRowCount ?? 0,
        reusedExistingBatch: true,
      };
    }
  }

  const existingKeys = await findExistingFounderKeys(input.founders);
  const classified = classifyFounders(input.founders, existingKeys);
  const uniqueFounders = classified.filter(
    (founder) => founder.status === "ready",
  );
  const duplicateCount = classified.length - uniqueFounders.length;
  const companyCount = new Set(
    uniqueFounders.map(
      (founder) => `${founder.companyName}\u0000${founder.normalizedDomain}`,
    ),
  ).size;

  let createdBatchId: string | null = null;
  try {
    const { data: batch, error: batchError } = await supabase
      .from("fev_batches")
      .insert(buildBatchInsertPayload({
        batchName,
        sourceFileName,
        sourceType: input.sourceType,
        discoveryRunId: input.discoveryRunId,
        companyCount,
        founderCount: uniqueFounders.length,
        duplicateCount,
      }))
      .select("id")
      .single();

    if (batchError || !batch) {
      if (input.discoveryRunId) {
        const existing = await findDiscoveryBatch(input.discoveryRunId);
        if (existing) {
          return {
            batchId: existing.id,
            insertedCount: existing.total_founders,
            duplicateCount: existing.duplicate_founders,
            invalidRowCount: input.invalidRowCount ?? 0,
            reusedExistingBatch: true,
          };
        }
      }
      throw new Error(
        `Could not create the batch: ${batchError?.message ?? "Unknown error"}`,
      );
    }

    createdBatchId = batch.id;

    if (uniqueFounders.length > 0) {
      const { error: foundersError } = await supabase
        .from("fev_founders")
        .insert(
          uniqueFounders.map((founder) => ({
            batch_id: batch.id,
            source_sheet_name: founder.sourceSheetName,
            source_row: founder.sourceRow,
            company_name: founder.companyName,
            website: founder.website,
            normalized_domain: founder.normalizedDomain,
            yc_batch: founder.ycBatch,
            accelerator_name: founder.acceleratorName,
            accelerator_batch: founder.acceleratorBatch,
            accelerator_year: founder.acceleratorYear,
            accelerator_region: founder.acceleratorRegion,
            source_url: founder.sourceUrl,
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
            status: "pending" as const,
          })),
        );

      if (foundersError) {
        throw new Error(`Could not insert founders: ${foundersError.message}`);
      }
    }

    return {
      batchId: batch.id,
      insertedCount: uniqueFounders.length,
      duplicateCount,
      invalidRowCount: input.invalidRowCount ?? 0,
      reusedExistingBatch: false,
    };
  } catch (error) {
    if (createdBatchId) {
      await supabase.from("fev_batches").delete().eq("id", createdBatchId);
    }
    throw error;
  }
}

async function findDiscoveryBatch(discoveryRunId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("fev_batches")
    .select("id, total_founders, duplicate_founders")
    .eq("discovery_run_id", discoveryRunId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not reconcile the discovery batch: ${error.message}`);
  }
  return data;
}
