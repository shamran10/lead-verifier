import Link from "next/link";
import { connection } from "next/server";

import { FiveHundredGlobalFinderControls } from "@/components/500-global-finder-controls";
import { FiveHundredGlobalRunControls } from "@/components/500-global-run-controls";
import { FiveHundredGlobalSourceForm } from "@/components/500-global-source-form";
import { StatusPill } from "@/components/status-pill";
import {
  getDiscoveryFinderProgress,
  getDiscoveryRun,
} from "@/lib/500-global/repository";
import { getCatalogCoverageWarnings } from "@/lib/500-global/source-catalog";
import { hasAdminSession, isAdminPasswordConfigured } from "@/lib/admin-session";

export const metadata = { title: "500 Global Run" };

export default async function FiveHundredGlobalRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  await connection();
  const authenticated = await hasAdminSession();
  if (!authenticated) return <AccessGate />;
  const { runId } = await params;
  let result;
  let progress;
  try {
    [result, progress] = await Promise.all([
      getDiscoveryRun(runId),
      getDiscoveryFinderProgress(runId),
    ]);
  } catch {
    return <div className="alert alert-error">This discovery run could not be loaded.</div>;
  }
  const { run, sources, events } = result;
  const readOnly = Boolean(run.imported_batch_id) || run.status === "completed";

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="eyebrow">Discovery run</p>
          <h1 className="page-title">{run.name}</h1>
          <div className="mt-3"><StatusPill status={run.status} /></div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link className="button button-secondary" href="/500-global/runs">All Runs</Link>
          {run.discovered_companies > 0 && (
            <Link className="button button-primary" href={`/500-global/runs/${run.id}/review`}>
              Open Review
            </Link>
          )}
          {run.imported_batch_id && (
            <Link className="button button-success" href={`/batches/${run.imported_batch_id}`}>
              Open Imported Batch
            </Link>
          )}
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Years" value={run.target_years.join(", ")} />
        <Stat label="Company regions" value={run.target_regions.map(regionLabel).join(", ")} />
        <Stat label="Maximum records" value={run.max_records.toLocaleString()} />
        <Stat label="Mode" value={run.dry_run ? "Dry run" : "Import enabled"} />
      </section>

      <FiveHundredGlobalFinderControls
        runId={run.id}
        initialProgress={progress}
        catalogWarnings={getCatalogCoverageWarnings(run.target_years)}
        readOnly={readOnly}
      />

      {!readOnly && (
        <details className="panel p-6">
          <summary className="cursor-pointer text-base font-bold text-slate-900">
            Advanced: add a source manually
          </summary>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Use this only for a separately verified official participant listing. Partner hosts
            require explicit administrator approval and still pass the same safe-fetch checks.
          </p>
          <div className="mt-5"><FiveHundredGlobalSourceForm runId={run.id} /></div>
        </details>
      )}

      <details>
        <summary className="cursor-pointer text-lg font-bold text-slate-900">Technical source queue</summary>
        <div className="mt-4">
          {!sources.length ? (
            <div className="empty-state text-sm text-slate-500">No source URLs have been queued.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>URL</th><th>Kind</th><th>Approval</th><th>Processing</th><th>Batch / year</th><th>Added</th></tr></thead>
                <tbody>
                  {sources.map((source) => (
                    <tr key={source.id}>
                      <td className="max-w-xl">
                        <a className="break-all font-semibold text-indigo-700" href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
                        <span className="mt-1 block text-xs text-slate-500">
                          {source.hostname}{source.host_approved_by_admin ? " · partner host approved by admin" : ""}
                        </span>
                      </td>
                      <td>{source.source_kind.replaceAll("_", " ")}</td>
                      <td><StatusPill status={source.approval_status} /></td>
                      <td><StatusPill status={source.processing_status} /></td>
                      <td>{source.accelerator_batch ?? "—"} / {source.accelerator_year ?? "—"}</td>
                      <td className="whitespace-nowrap text-xs text-slate-500">{formatDate(source.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-lg font-bold text-slate-900">Technical event history</summary>
        <div className="mt-4">
          {!events.length ? (
            <div className="empty-state text-sm text-slate-500">No events recorded.</div>
          ) : (
            <ol className="panel divide-y divide-slate-200">
              {events.map((event) => (
                <li key={event.id} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <span className="mr-2 text-xs font-bold uppercase text-slate-500">{event.event_type.replaceAll("_", " ")}</span>
                    <span className={event.level === "error" ? "text-sm text-red-700" : "text-sm text-slate-700"}>{event.message}</span>
                  </div>
                  <time className="text-xs text-slate-500">{formatDate(event.created_at)}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="panel p-5"><p className="text-sm font-bold text-slate-950">{value}</p><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p></div>;
}

function regionLabel(value: string) {
  return value === "north_america" ? "North America" : value === "europe" ? "Europe" : value;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function AccessGate() {
  return <div className="space-y-6"><h1 className="page-title">Administrator access required</h1><FiveHundredGlobalRunControls initialAuthenticated={false} adminPasswordConfigured={isAdminPasswordConfigured()} showCreateForm={false} /></div>;
}
