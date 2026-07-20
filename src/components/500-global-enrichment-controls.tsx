"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import type {
  DiscoveryEnrichmentNextResult,
  DiscoveryEnrichmentProgress,
} from "@/lib/500-global/types";

type Props = {
  runId: string;
  initialProgress: DiscoveryEnrichmentProgress;
  readOnly: boolean;
};

export function FiveHundredGlobalEnrichmentControls({
  runId,
  initialProgress,
  readOnly,
}: Props) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRequested = useRef(false);

  async function processOne() {
    setError(null);
    const response = await fetch(
      `/api/500-global/runs/${encodeURIComponent(runId)}/enrich/next`,
      { method: "POST", credentials: "same-origin" },
    );
    const body = await readJson<DiscoveryEnrichmentNextResult>(response);
    setProgress(body.progress);
    setMessage(body.message);
    return body;
  }

  async function runLoop() {
    stopRequested.current = false;
    setRunning(true);
    setError(null);
    try {
      while (!stopRequested.current) {
        const result = await processOne();
        if (result.outcome === "complete" || result.outcome === "paused") break;
        if (result.outcome === "idle") await new Promise((resolve) => setTimeout(resolve, 800));
      }
      router.refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setRunning(false);
    }
  }

  async function processNext() {
    setRunning(true);
    try {
      await processOne();
      router.refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel space-y-5 p-5 lg:p-6">
      <div>
        <p className="eyebrow">Company enrichment</p>
        <h2 className="mt-1 text-lg font-bold text-slate-950">Find Headquarters &amp; Founders</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Checks up to five public pages on each company website. LinkedIn pages and Reoon are never called.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="Checked" value={`${progress.checkedCompanies}/${progress.totalCompanies}`} />
        <Stat label="Pending" value={progress.pendingCompanies} />
        <Stat label="Eligible" value={progress.eligibleCompanies} />
        <Stat label="Needs review" value={progress.needsReviewCompanies} />
        <Stat label="Ineligible" value={progress.ineligibleCompanies} />
        <Stat label="Founders" value={progress.foundersFound} />
      </div>

      <div className="flex flex-wrap gap-3">
        <button className="button button-primary" type="button" disabled={readOnly || running} onClick={runLoop}>
          {running ? "Enriching…" : progress.checkedCompanies ? "Resume Enrichment" : "Enrich Companies"}
        </button>
        <button className="button button-secondary" type="button" disabled={readOnly || running} onClick={processNext}>
          Process Next Company
        </button>
        {running && (
          <button className="button button-secondary" type="button" onClick={() => { stopRequested.current = true; }}>
            Pause after current company
          </button>
        )}
      </div>
      {message && <p className="text-sm text-slate-600">{message}</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl bg-slate-50 p-3"><p className="font-bold text-slate-950">{value}</p><p className="mt-1 text-xs font-semibold uppercase text-slate-500">{label}</p></div>;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? "The enrichment request failed.");
  return body;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The enrichment request failed.";
}
