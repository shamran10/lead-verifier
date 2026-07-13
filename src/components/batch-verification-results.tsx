import { Fragment } from "react";
import Link from "next/link";

import { StatusPill } from "@/components/status-pill";
import type {
  BatchDetail,
  BatchOutcomeCounts,
  BatchPagination,
  BatchResultFilter,
  FounderListItem,
  VerificationAttemptListItem,
} from "@/lib/queries";

type Props = {
  batch: BatchDetail;
  counts: BatchOutcomeCounts;
  founders: FounderListItem[];
  filter: BatchResultFilter;
  pagination: BatchPagination;
};

const FILTERS: Array<{ value: BatchResultFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "valid", label: "Valid" },
  { value: "no_valid_email", label: "No valid email" },
  { value: "errors", label: "Errors" },
  { value: "pending", label: "Pending" },
];

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function BatchVerificationResults({
  batch,
  counts,
  founders,
  filter,
  pagination,
}: Props) {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="section-title">Verification results</h2>
        <p className="mt-1 text-sm text-slate-500">
          Outcome totals are calculated from the current founder records.
        </p>
      </div>

      <div className="results-summary-grid">
        <SummaryCard label="Total founders" value={counts.totalFounders} />
        <SummaryCard label="Valid emails" value={counts.validEmails} tone="success" />
        <SummaryCard label="No valid email" value={counts.noValidEmails} tone="warning" />
        <SummaryCard label="Verification errors" value={counts.verificationErrors} tone="error" />
        <SummaryCard label="Pending / verifying" value={counts.pendingFounders} tone="active" />
        <SummaryCard label="Duplicates skipped" value={batch.duplicate_founders} />
      </div>

      <div className="operational-totals" role="note">
        Stored operational totals: {batch.total_founders} founders · {batch.valid_emails} valid · {batch.no_valid_emails} no valid email
      </div>

      <nav className="result-filters" aria-label="Filter verification results">
        {FILTERS.map((item) => (
          <Link
            key={item.value}
            className={`result-filter${filter === item.value ? " result-filter-active" : ""}`}
            href={filterHref(batch.id, item.value)}
            aria-current={filter === item.value ? "page" : undefined}
          >
            {item.label}
            <span>{filterCount(counts, item.value)}</span>
          </Link>
        ))}
      </nav>

      <div className="table-wrap">
        <table className="results-table">
          <thead>
            <tr>
              <th>Founder</th>
              <th>Company</th>
              <th>First candidate</th>
              <th>Last candidate</th>
              <th>Selected email</th>
              <th>Selected pattern</th>
              <th>Final status</th>
              <th>Verification status</th>
            </tr>
          </thead>
          <tbody>
            {founders.map((founder) => (
              <Fragment key={founder.id}>
                <tr>
                  <td>
                    <p className="font-semibold text-slate-900">{founder.founder_name}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {founder.source_sheet_name ?? "Unknown sheet"}
                      {founder.source_row ? ` · row ${founder.source_row}` : ""}
                    </p>
                  </td>
                  <td>
                    <p className="font-semibold text-slate-800">{founder.company_name}</p>
                    <p className="mt-1 text-xs text-slate-500">{founder.normalized_domain}</p>
                  </td>
                  <td className="font-mono text-xs">{founder.first_candidate_email}</td>
                  <td className="font-mono text-xs">{founder.last_candidate_email ?? "—"}</td>
                  <td>
                    {founder.selected_email ? (
                      <span className="selected-email">{founder.selected_email}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td>{formatStatus(founder.selected_pattern)}</td>
                  <td><StatusPill status={founder.status} /></td>
                  <td>
                    {founder.verification_status ? (
                      <StatusPill status={founder.verification_status} />
                    ) : (
                      <span className="text-xs text-slate-400">Not checked</span>
                    )}
                  </td>
                </tr>
                <tr className="history-row">
                  <td colSpan={8}>
                    <VerificationHistory attempts={founder.attempts} />
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        {founders.length === 0 && (
          <div className="empty-state rounded-none border-0">
            No founders match this result filter.
          </div>
        )}
      </div>

      <Pagination batchId={batch.id} filter={filter} pagination={pagination} />
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning" | "error" | "active";
}) {
  return (
    <div className={`result-summary-card result-summary-${tone}`}>
      <p>{value}</p>
      <span>{label}</span>
    </div>
  );
}

function VerificationHistory({ attempts }: { attempts: VerificationAttemptListItem[] }) {
  return (
    <details className="verification-history">
      <summary>
        Verification history <span>({attempts.length})</span>
      </summary>
      {attempts.length === 0 ? (
        <p className="history-empty">No candidate has been checked yet.</p>
      ) : (
        <div className="history-list">
          {attempts.map((attempt) => (
            <article className="history-attempt" key={attempt.id}>
              <div className="history-attempt-heading">
                <div>
                  <p className="font-mono text-xs font-semibold text-slate-900">
                    {attempt.candidate_email}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatStatus(attempt.candidate_type)} · {formatProvider(attempt.provider)} · {formatDate(attempt.attempted_at)}
                  </p>
                </div>
                <StatusPill status={attempt.verification_status ?? "processing"} />
              </div>
              <dl className="history-flags">
                <Flag label="Safe to send" value={attempt.is_safe_to_send} />
                <Flag label="Catch-all" value={attempt.is_catch_all} />
                <Flag label="Role-based" value={attempt.is_role_based} />
                <Flag label="Disposable" value={attempt.is_disposable} />
              </dl>
              {attempt.error_message && (
                <p className="history-error">{attempt.error_message}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </details>
  );
}

function Flag({ label, value }: { label: string; value: boolean | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === null ? "—" : value ? "Yes" : "No"}</dd>
    </div>
  );
}

function Pagination({
  batchId,
  filter,
  pagination,
}: {
  batchId: string;
  filter: BatchResultFilter;
  pagination: BatchPagination;
}) {
  if (pagination.totalPages <= 1) return null;

  return (
    <nav className="results-pagination" aria-label="Verification result pages">
      <p>
        Page {pagination.page} of {pagination.totalPages} · {pagination.totalItems} results
      </p>
      <div>
        {pagination.page > 1 && (
          <Link className="button button-secondary" href={pageHref(batchId, filter, pagination.page - 1)}>
            Previous
          </Link>
        )}
        {pagination.page < pagination.totalPages && (
          <Link className="button button-secondary" href={pageHref(batchId, filter, pagination.page + 1)}>
            Next
          </Link>
        )}
      </div>
    </nav>
  );
}

function filterHref(batchId: string, filter: BatchResultFilter) {
  return `/batches/${encodeURIComponent(batchId)}?filter=${filter}`;
}

function pageHref(batchId: string, filter: BatchResultFilter, page: number) {
  return `${filterHref(batchId, filter)}&page=${page}`;
}

function filterCount(counts: BatchOutcomeCounts, filter: BatchResultFilter) {
  if (filter === "valid") return counts.validEmails;
  if (filter === "no_valid_email") return counts.noValidEmails;
  if (filter === "errors") return counts.verificationErrors;
  if (filter === "pending") return counts.pendingFounders;
  return counts.totalFounders;
}

function formatStatus(value: string | null) {
  return value ? value.replaceAll("_", " ") : "—";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : dateFormatter.format(date);
}

function formatProvider(value: string) {
  return value.trim().toLowerCase() === "reoon" ? "Reoon" : "Verification provider";
}
