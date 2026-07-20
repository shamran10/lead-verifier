import Link from "next/link";
import { connection } from "next/server";

import { FiveHundredGlobalRunControls } from "@/components/500-global-run-controls";
import { FiveHundredGlobalRunTable } from "@/components/500-global-run-table";
import { listDiscoveryRuns } from "@/lib/500-global/repository";
import type { DiscoveryRunListItem } from "@/lib/500-global/types";
import {
  hasAdminSession,
  isAdminPasswordConfigured,
} from "@/lib/admin-session";

export const metadata = { title: "500 Global Lead Finder" };

export default async function FiveHundredGlobalPage() {
  await connection();
  const authenticated = await hasAdminSession();
  let runs: DiscoveryRunListItem[] = [];
  let loadError: string | null = null;
  if (authenticated) {
    try {
      runs = await listDiscoveryRuns(10);
    } catch {
      loadError = "Discovery runs are unavailable. Confirm the Phase 1 Supabase SQL has been applied.";
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="eyebrow">500 Global Lead Finder</p>
          <h1 className="page-title">Curated discovery, with a human review boundary</h1>
          <p className="page-description max-w-3xl">
            Add official or explicitly approved source URLs, review the evidence-backed records, and import only approved founders into the existing verifier.
          </p>
        </div>
        {authenticated && <Link className="button button-secondary" href="/500-global/runs">All Runs</Link>}
      </div>

      <section className="panel p-6 sm:p-8">
        <h2 className="section-title">Workflow boundary</h2>
        <ol className="mt-5 grid gap-3 text-sm font-semibold text-slate-700 sm:grid-cols-2 lg:grid-cols-6">
          {["Curated source URLs", "Discovery processing", "Review", "Approve", "Import parsed batch", "Start verification later"].map((step, index) => (
            <li key={step} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="mb-2 block text-xs text-indigo-600">{index + 1}</span>{step}</li>
          ))}
        </ol>
        <div className="alert alert-warning mt-5">
          Phase 1 stores source URLs but does not fetch or scrape them. Import never calls Reoon and never starts verification automatically.
        </div>
      </section>

      <FiveHundredGlobalRunControls
        initialAuthenticated={authenticated}
        adminPasswordConfigured={isAdminPasswordConfigured()}
      />

      {authenticated && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <div><h2 className="section-title">Recent Runs</h2><p className="mt-1 text-sm text-slate-500">Most recently created discovery scopes.</p></div>
            <Link className="text-sm font-semibold text-indigo-700" href="/500-global/runs">View all</Link>
          </div>
          {loadError ? <div className="alert alert-error">{loadError}</div> : <FiveHundredGlobalRunTable runs={runs} />}
        </section>
      )}
    </div>
  );
}
