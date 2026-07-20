import Link from "next/link";

import { StatusPill } from "@/components/status-pill";
import type { BatchListItem } from "@/lib/queries";
import { sourceTypeLabel } from "@/lib/types";

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function BatchTable({ batches }: { batches: BatchListItem[] }) {
  if (batches.length === 0) {
    return (
      <div className="empty-state">
        <p className="font-semibold text-slate-900">No batches yet</p>
        <p className="mt-1 text-sm text-slate-500">
          Upload your first workbook to begin reviewing founder candidates.
        </p>
        <Link className="button button-primary mt-5" href="/upload">
          Upload XLSX
        </Link>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Batch</th>
            <th>Source</th>
            <th>Status</th>
            <th>Companies</th>
            <th>Founders</th>
            <th>Duplicates</th>
            <th>Created</th>
            <th aria-label="View batch" />
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <p className="font-semibold text-slate-900">{batch.batch_name}</p>
                <p className="mt-1 max-w-60 truncate text-xs text-slate-500">
                  {batch.source_file_name}
                </p>
              </td>
              <td>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                  {sourceTypeLabel(batch.source_type)}
                </span>
              </td>
              <td>
                <StatusPill status={batch.status} />
              </td>
              <td>{batch.total_companies}</td>
              <td>{batch.total_founders}</td>
              <td>{batch.duplicate_founders}</td>
              <td className="whitespace-nowrap text-slate-500">
                {dateFormatter.format(new Date(batch.created_at))}
              </td>
              <td className="text-right">
                <Link
                  className="text-sm font-semibold text-indigo-700 hover:text-indigo-900"
                  href={`/batches/${batch.id}`}
                >
                  Review
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
