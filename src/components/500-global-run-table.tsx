import Link from "next/link";

import { StatusPill } from "@/components/status-pill";
import type { DiscoveryRunListItem } from "@/lib/500-global/types";

export function FiveHundredGlobalRunTable({ runs }: { runs: DiscoveryRunListItem[] }) {
  if (!runs.length) {
    return <div className="empty-state text-sm text-slate-500">No discovery runs have been created.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Scope</th><th>Sources</th><th>Companies</th><th>Review</th><th>Imported</th><th>Created</th></tr></thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td><Link className="font-bold text-indigo-700 hover:text-indigo-900" href={`/500-global/runs/${run.id}`}>{run.name}</Link></td>
              <td><StatusPill status={run.status} /></td>
              <td className="whitespace-nowrap text-xs text-slate-600">{run.target_years.join(", ")}<br />{run.target_regions.map(regionLabel).join(", ")}</td>
              <td>{run.total_sources}</td>
              <td><span className="font-semibold">{run.discovered_companies}</span><span className="block text-xs text-slate-500">{run.eligible_companies} eligible</span></td>
              <td className="text-xs text-slate-600">{run.review_companies} needs review<br />{run.approved_companies} approved · {run.rejected_companies} rejected</td>
              <td>{run.imported_founders}</td>
              <td className="whitespace-nowrap text-xs text-slate-500">{formatDate(run.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function regionLabel(region: string) {
  return region === "north_america" ? "North America" : region === "europe" ? "Europe" : region;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
