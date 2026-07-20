import Link from "next/link";
import { connection } from "next/server";

import { FiveHundredGlobalRunControls } from "@/components/500-global-run-controls";
import { FiveHundredGlobalRunTable } from "@/components/500-global-run-table";
import { listDiscoveryRuns } from "@/lib/500-global/repository";
import { hasAdminSession, isAdminPasswordConfigured } from "@/lib/admin-session";

export const metadata = { title: "500 Global Runs" };

export default async function FiveHundredGlobalRunsPage() {
  await connection();
  const authenticated = await hasAdminSession();
  if (!authenticated) {
    return <AccessGate />;
  }

  let runs;
  try {
    runs = await listDiscoveryRuns(100);
  } catch {
    return <div className="alert alert-error">Discovery runs are unavailable. Confirm the Phase 1 Supabase SQL has been applied.</div>;
  }

  return (
      <div>
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="eyebrow">500 Global Lead Finder</p><h1 className="page-title">Discovery runs</h1><p className="page-description">Review bounded run scopes and their source, review, and import counters.</p></div>
          <Link className="button button-primary" href="/500-global">Create Run</Link>
        </div>
        <FiveHundredGlobalRunTable runs={runs} />
      </div>
  );
}

function AccessGate() {
  return <div className="space-y-6"><div><p className="eyebrow">Protected</p><h1 className="page-title">Administrator access required</h1></div><FiveHundredGlobalRunControls initialAuthenticated={false} adminPasswordConfigured={isAdminPasswordConfigured()} showCreateForm={false} /></div>;
}
