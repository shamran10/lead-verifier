import Link from "next/link";
import { connection } from "next/server";

import { BatchTable } from "@/components/batch-table";
import { getDashboardData } from "@/lib/queries";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await connection();

  let data;
  try {
    data = await getDashboardData();
  } catch (error) {
    return <DataError error={error} />;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Overview</p>
          <h1 className="page-title">Founder imports</h1>
          <p className="page-description">
            Upload, extract, and review candidate emails before verification.
          </p>
        </div>
        <Link className="button button-primary" href="/upload">
          Upload XLSX
        </Link>
      </div>

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Import totals">
        <StatCard label="Total batches" value={data.batchCount} />
        <StatCard label="Imported founders" value={data.founderCount} />
        <StatCard label="Awaiting review" value={data.pendingCount} />
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="section-title">Recent batches</h2>
            <p className="mt-1 text-sm text-slate-500">
              Latest parsed founder workbooks.
            </p>
          </div>
          <Link
            className="text-sm font-semibold text-indigo-700 hover:text-indigo-900"
            href="/batches"
          >
            View all
          </Link>
        </div>
        <BatchTable batches={data.recent} />
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel p-6">
      <p className="text-3xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-2 text-sm font-medium text-slate-500">{label}</p>
    </div>
  );
}

function DataError({ error }: { error: unknown }) {
  return (
    <div className="alert alert-error">
      <strong>Dashboard data is unavailable.</strong>{" "}
      {error instanceof Error ? error.message : "Check the Supabase configuration."}
    </div>
  );
}
