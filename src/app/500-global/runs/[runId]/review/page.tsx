import Link from "next/link";
import { connection } from "next/server";

import { FiveHundredGlobalReviewTable } from "@/components/500-global-review-table";
import { FiveHundredGlobalEnrichmentControls } from "@/components/500-global-enrichment-controls";
import { FiveHundredGlobalRunControls } from "@/components/500-global-run-controls";
import {
  getDiscoveryEnrichmentProgress,
  getDiscoveryReview,
  getDiscoveryRun,
} from "@/lib/500-global/repository";
import { normalizeDiscoveryReviewFilter } from "@/lib/500-global/types";
import { hasAdminSession, isAdminPasswordConfigured } from "@/lib/admin-session";

export const metadata = { title: "500 Global Review" };

export default async function FiveHundredGlobalReviewPage({ params, searchParams }: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const authenticated = await hasAdminSession();
  if (!authenticated) return <AccessGate />;
  const [{ runId }, query] = await Promise.all([params, searchParams]);
  const filter = normalizeDiscoveryReviewFilter(query.filter);
  const pageValue = Array.isArray(query.page) ? query.page[0] : query.page;
  const page = Math.max(1, Number.parseInt(pageValue ?? "1", 10) || 1);
  let result;
  try {
    result = await Promise.all([
      getDiscoveryRun(runId),
      getDiscoveryReview(runId, filter, page, 25),
      getDiscoveryEnrichmentProgress(runId),
    ]);
  } catch {
    return <div className="alert alert-error">The discovery review could not be loaded.</div>;
  }
  const [{ run }, review, enrichmentProgress] = result;
  const readOnly = Boolean(run.imported_batch_id) || run.status === "completed";
  return (
      <div className="space-y-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow">500 Global review</p><h1 className="page-title">{run.name}</h1><p className="page-description">Correct evidence-backed metadata, approve companies and founders, then import one parsed batch.</p></div><Link className="button button-secondary" href={`/500-global/runs/${run.id}`}>Run Details</Link></div>
        <FiveHundredGlobalEnrichmentControls runId={run.id} initialProgress={enrichmentProgress} readOnly={readOnly} />
        <FiveHundredGlobalReviewTable runId={run.id} companies={review.companies} pagination={review.pagination} filter={filter} dryRun={run.dry_run} importedBatchId={run.imported_batch_id} />
      </div>
  );
}

function AccessGate() { return <div className="space-y-6"><h1 className="page-title">Administrator access required</h1><FiveHundredGlobalRunControls initialAuthenticated={false} adminPasswordConfigured={isAdminPasswordConfigured()} showCreateForm={false} /></div>; }
