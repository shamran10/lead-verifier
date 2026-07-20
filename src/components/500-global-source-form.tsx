"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export function FiveHundredGlobalSourceForm({ runId }: { runId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [sourceKind, setSourceKind] = useState("cohort_roster");
  const [acceleratorBatch, setAcceleratorBatch] = useState("");
  const [acceleratorYear, setAcceleratorYear] = useState("");
  const [approvePartnerHost, setApprovePartnerHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/500-global/runs/${encodeURIComponent(runId)}/sources`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, sourceKind, acceleratorBatch, acceleratorYear, approvePartnerHost }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not add the source.");
      setUrl("");
      setAcceleratorBatch("");
      setAcceleratorYear("");
      setApprovePartnerHost(false);
      router.refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not add the source.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel p-6" onSubmit={submit}>
      <h2 className="section-title">Add curated source</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">This queues a source for the same one-at-a-time safe processing workflow.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><label className="label" htmlFor="source-url">HTTPS URL</label><input id="source-url" className="input" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://500.co/…" /></div>
        <div><label className="label" htmlFor="source-kind">Source kind</label><select id="source-kind" className="input" value={sourceKind} onChange={(event) => setSourceKind(event.target.value)}>{["cohort_roster", "program_page", "announcement", "demo_day", "partner_program", "manual"].map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></div>
        <div><label className="label" htmlFor="source-year">Accelerator year</label><select id="source-year" className="input" value={acceleratorYear} onChange={(event) => setAcceleratorYear(event.target.value)}><option value="">Not set</option><option value="2025">2025</option><option value="2026">2026</option></select></div>
        <div><label className="label" htmlFor="source-batch">Accelerator batch</label><input id="source-batch" className="input" maxLength={120} value={acceleratorBatch} onChange={(event) => setAcceleratorBatch(event.target.value)} /></div>
        <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><input className="mt-1" type="checkbox" checked={approvePartnerHost} onChange={(event) => setApprovePartnerHost(event.target.checked)} /><span className="text-sm leading-5 text-amber-900"><strong className="block">Explicitly approve partner host</strong>Required for non-500.co domains. Leave clear to keep the source unapproved.</span></label>
      </div>
      {error && <p className="alert alert-error mt-4">{error}</p>}
      <button className="button button-primary mt-5" type="submit" disabled={busy}>{busy ? "Adding…" : "Add Source"}</button>
    </form>
  );
}
