"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import type {
  DiscoveryCompanyReviewItem,
  DiscoveryReviewFilter,
  DiscoveryReviewPagination,
} from "@/lib/500-global/types";

type Props = {
  runId: string;
  companies: DiscoveryCompanyReviewItem[];
  pagination: DiscoveryReviewPagination;
  filter: DiscoveryReviewFilter;
  dryRun: boolean;
  importedBatchId: string | null;
};

const filters: DiscoveryReviewFilter[] = [
  "action_required",
  "eligible",
  "needs_review",
  "ineligible",
  "approved",
  "rejected",
  "all",
];

export function FiveHundredGlobalReviewTable({
  runId,
  companies,
  pagination,
  filter,
  dryRun,
  importedBatchId,
}: Props) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(key: string, body: Record<string, unknown>) {
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch(`/api/500-global/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await readJson(response);
      router.refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setBusyKey(null);
    }
  }

  async function importApproved() {
    setBusyKey("import");
    setError(null);
    try {
      const response = await fetch(`/api/500-global/runs/${encodeURIComponent(runId)}/import`, {
        method: "POST",
        credentials: "same-origin",
      });
      const body = await readJson<{ batchId: string }>(response);
      router.push(`/batches/${encodeURIComponent(body.batchId)}`);
      router.refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <nav className="result-filters" aria-label="Review filters">
          {filters.map((item) => (
            <Link
              key={item}
              className={`result-filter ${filter === item ? "result-filter-active" : ""}`}
              href={`/500-global/runs/${runId}/review?filter=${item}`}
            >
              {item === "action_required"
                ? "Action Required"
                : item === "all"
                  ? "All / Audit"
                  : titleCase(item)}
            </Link>
          ))}
        </nav>
        {importedBatchId ? (
          <Link className="button button-success" href={`/batches/${importedBatchId}`}>
            Open Imported Batch
          </Link>
        ) : (
          <button
            className="button button-success"
            type="button"
            disabled={dryRun || busyKey === "import"}
            title={dryRun ? "Dry-run discovery runs cannot import." : undefined}
            onClick={importApproved}
          >
            {busyKey === "import" ? "Importing…" : "Import Approved"}
          </button>
        )}
      </div>

      <div className="alert alert-warning">
        Import creates a parsed batch only. Reoon verification never starts automatically; an administrator must start it later from the batch page.
        {dryRun && <strong className="ml-1">This is a dry run, so import is disabled.</strong>}
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {!companies.length ? (
        <div className="empty-state">
          <p className="font-semibold text-slate-800">No companies have been found yet.</p>
          <p className="mt-2 text-sm text-slate-500">Return to the run and select Find 500 Global Leads.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {companies.map((company) => (
            <CompanyCard
              key={company.id}
              company={company}
              busyKey={busyKey}
              mutate={mutate}
            />
          ))}
        </div>
      )}

      {pagination.totalItems > 0 && (
        <div className="results-pagination">
          <p>Page {pagination.page} of {pagination.totalPages} · {pagination.totalItems} companies</p>
          <div>
            {pagination.page > 1 && <Link className="button button-secondary" href={pageHref(runId, filter, pagination.page - 1)}>Previous</Link>}
            {pagination.page < pagination.totalPages && <Link className="button button-secondary" href={pageHref(runId, filter, pagination.page + 1)}>Next</Link>}
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyCard({ company, busyKey, mutate }: {
  company: DiscoveryCompanyReviewItem;
  busyKey: string | null;
  mutate: (key: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const imported = company.import_status === "imported";
  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(`company-edit-${company.id}`, {
      action: "edit_company",
      companyId: company.id,
      companyName: data.get("companyName"),
      website: data.get("website"),
      country: data.get("country"),
      acceleratorBatch: data.get("acceleratorBatch"),
      acceleratorYear: data.get("acceleratorYear"),
      sourceUrl: data.get("sourceUrl"),
      description: data.get("description"),
      industry: data.get("industry"),
    });
  }

  return (
    <article className="panel overflow-hidden">
      <div className="grid gap-5 p-5 lg:grid-cols-[1.2fr_1fr_auto] lg:p-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-slate-950">{company.company_name}</h2>
            <Badge value={company.eligibility_status} />
            <Badge value={company.review_status} />
            <Badge value={company.import_status} />
          </div>
          <p className="mt-2 text-sm text-slate-600">
            {company.website ?? "Website missing"} · {company.headquarters_country ?? "Country missing"} · {regionLabel(company.accelerator_region)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {company.accelerator_batch ?? "Batch not set"} · {company.accelerator_year ?? "Year not set"}
          </p>
          <a className="mt-3 block break-all text-xs font-semibold text-indigo-700 hover:text-indigo-900" href={company.source_url} target="_blank" rel="noreferrer">{company.source_url}</a>
        </div>
        <div className="text-xs leading-5 text-slate-600">
          <ReasonList label="Eligibility reasons" values={company.eligibility_reasons} />
          <ReasonList label="Warnings" values={company.warnings} />
        </div>
        <div className="flex flex-wrap content-start gap-2 lg:max-w-44">
          <button className="button button-success" type="button" disabled={imported || busyKey !== null} onClick={() => mutate(`company-approve-${company.id}`, { action: "review_company", companyId: company.id, decision: "approved" })}>Approve</button>
          <button className="button button-secondary" type="button" disabled={imported || busyKey !== null} onClick={() => mutate(`company-reject-${company.id}`, { action: "review_company", companyId: company.id, decision: "rejected" })}>Reject</button>
        </div>
      </div>

      {imported && <div className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-xs font-semibold text-amber-900">Imported records are read-only. Edit the resulting batch only through its existing workflow.</div>}

      <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 lg:px-6">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Founders</h3>
        {company.founders.length ? (
          <ul className="mt-3 space-y-3">
            {company.founders.map((founder) => (
              <li key={founder.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold text-slate-900">{founder.founder_name}{founder.founder_role ? ` · ${founder.founder_role}` : ""}</p>
                  <p className="mt-1 text-xs text-slate-500">{founder.active_status} · review {founder.review_status} · {founder.duplicate_status} · {founder.import_status}</p>
                  {founder.linkedin_url && <a className="mt-1 block text-xs text-indigo-700" href={founder.linkedin_url} target="_blank" rel="noreferrer">LinkedIn evidence</a>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="button button-success" type="button" disabled={imported || busyKey !== null} onClick={() => mutate(`founder-approve-${founder.id}`, { action: "review_founder", founderId: founder.id, decision: "approved" })}>Approve</button>
                  <button className="button button-secondary" type="button" disabled={imported || busyKey !== null} onClick={() => mutate(`founder-reject-${founder.id}`, { action: "review_founder", founderId: founder.id, decision: "rejected" })}>Reject</button>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" checked={founder.include_in_import} disabled={imported || busyKey !== null} onChange={(event) => mutate(`founder-include-${founder.id}`, { action: "include_founder", founderId: founder.id, include: event.target.checked })} />Include</label>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-slate-500">No founders are attached to this company.</p>}
      </div>

      {!imported && (
        <details className="border-t border-slate-200 px-5 py-4 lg:px-6">
          <summary className="cursor-pointer text-sm font-bold text-indigo-700">Edit company metadata</summary>
          <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={saveEdit}>
            <EditField name="companyName" label="Company name" value={company.company_name} required />
            <EditField name="website" label="Website" value={company.website ?? ""} required />
            <EditField name="country" label="Company country" value={company.headquarters_country ?? ""} required />
            <EditField name="industry" label="Industry" value={company.industry ?? ""} />
            <EditField name="acceleratorBatch" label="Accelerator batch" value={company.accelerator_batch ?? ""} />
            <EditField name="acceleratorYear" label="Accelerator year" value={company.accelerator_year?.toString() ?? ""} required />
            <div className="md:col-span-2"><EditField name="sourceUrl" label="Source URL" value={company.source_url} required /></div>
            <div className="md:col-span-2"><label className="label" htmlFor={`description-${company.id}`}>Description</label><textarea id={`description-${company.id}`} className="input min-h-28" name="description" defaultValue={company.description ?? ""} /></div>
            <button className="button button-primary md:col-span-2 md:justify-self-start" type="submit" disabled={busyKey !== null}>{busyKey === `company-edit-${company.id}` ? "Saving…" : "Save corrections"}</button>
          </form>
        </details>
      )}
    </article>
  );
}

function EditField({ name, label, value, required = false }: { name: string; label: string; value: string; required?: boolean }) {
  return <div><label className="label" htmlFor={`${name}-${value}`}>{label}</label><input id={`${name}-${value}`} className="input" name={name} defaultValue={value} required={required} /></div>;
}

function ReasonList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return <div className="mb-2"><strong className="text-slate-700">{label}:</strong><ul className="list-disc pl-4">{values.map((value) => <li key={value}>{value}</li>)}</ul></div>;
}

function Badge({ value }: { value: string }) {
  return <span className="status-pill status-pill-neutral">{value.replaceAll("_", " ")}</span>;
}

function regionLabel(value: string | null) {
  if (value === "north_america") return "North America";
  if (value === "europe") return "Europe";
  return "Region missing";
}

function pageHref(runId: string, filter: DiscoveryReviewFilter, page: number) {
  return `/500-global/runs/${runId}/review?filter=${filter}&page=${page}`;
}

async function readJson<T = unknown>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed.");
  return body;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
