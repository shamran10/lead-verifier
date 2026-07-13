import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { BatchVerificationResults } from "@/components/batch-verification-results";
import { SmartleadExportButton } from "@/components/smartlead-export-button";
import { StatusPill } from "@/components/status-pill";
import { VerificationControls } from "@/components/verification-controls";
import {
  hasAdminSession,
  isAdminPasswordConfigured,
} from "@/lib/admin-session";
import {
  getBatchDetails,
  normalizeBatchResultFilter,
} from "@/lib/queries";
import { getVerificationProgress } from "@/lib/verification";

export const metadata = { title: "Batch details" };

export default async function BatchDetailsPage(
  props: PageProps<"/batches/[batchId]">,
) {
  await connection();
  const { batchId } = await props.params;
  const searchParams = await props.searchParams;
  const filter = normalizeBatchResultFilter(searchParams.filter);
  const requestedPage = parsePage(searchParams.page);

  let details;
  try {
    details = await getBatchDetails(batchId, {
      filter,
      page: requestedPage,
      pageSize: 50,
    });
  } catch (error) {
    return <BatchLoadError error={error} />;
  }

  const { batch } = details;
  if (!batch) notFound();

  let progress;
  let authenticated;
  try {
    [progress, authenticated] = await Promise.all([
      getVerificationProgress(batchId),
      hasAdminSession(),
    ]);
  } catch (error) {
    return <BatchLoadError error={error} />;
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          className="text-sm font-semibold text-indigo-700 hover:text-indigo-900"
          href="/batches"
        >
          ← All batches
        </Link>
        <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <p className="eyebrow">Batch review</p>
              <StatusPill status={batch.status} />
            </div>
            <h1 className="page-title">{batch.batch_name}</h1>
            <p className="page-description">{batch.source_file_name}</p>
          </div>
          <SmartleadExportButton
            batchId={batch.id}
            validCount={details.counts.validEmails}
            initialAuthenticated={authenticated}
            adminPasswordConfigured={isAdminPasswordConfigured()}
          />
        </div>
      </div>

      <VerificationControls
        batchId={batch.id}
        initialProgress={progress}
        initialAuthenticated={authenticated}
        adminPasswordConfigured={isAdminPasswordConfigured()}
      />

      <BatchVerificationResults
        batch={batch}
        counts={details.counts}
        founders={details.founders}
        filter={details.filter}
        pagination={details.pagination}
      />
    </div>
  );
}

function parsePage(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(candidate ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function BatchLoadError({ error }: { error: unknown }) {
  return (
    <div className="alert alert-error">
      <strong>Batch data is unavailable.</strong>{" "}
      {error instanceof Error ? error.message : "Check Supabase and try again."}
    </div>
  );
}
