"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import type {
  DiscoveryFinderProgress,
  DiscoveryNextResult,
  DiscoverySeedResult,
} from "@/lib/500-global/types";

type Props = {
  runId: string;
  initialProgress: DiscoveryFinderProgress;
  catalogWarnings: string[];
  readOnly: boolean;
};

export function FiveHundredGlobalFinderControls({
  runId,
  initialProgress,
  catalogWarnings,
  readOnly,
}: Props) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(catalogWarnings);
  const [error, setError] = useState<string | null>(null);
  const stopRequested = useRef(false);

  async function findLeads() {
    setRunning(true);
    setError(null);
    setMessage("Queuing verified official participant sources…");
    stopRequested.current = false;
    try {
      const seeded = await postJson<DiscoverySeedResult>(
        `/api/500-global/runs/${encodeURIComponent(runId)}/seed`,
      );
      setProgress(seeded.progress);
      setWarnings(seeded.warnings);
      setMessage(
        seeded.addedSources
          ? `${seeded.addedSources} verified official source queued.`
          : "Verified official sources were already queued.",
      );
      await runSequentialLoop();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  async function runSequentialLoop() {
    while (!stopRequested.current) {
      const next = await postJson<DiscoveryNextResult>(
        `/api/500-global/runs/${encodeURIComponent(runId)}/next`,
      );
      setProgress(next.progress);
      setMessage(next.message);
      router.refresh();
      if (["complete", "deferred", "idle", "paused"].includes(next.outcome)) return;
    }
  }

  async function pause() {
    stopRequested.current = true;
    setError(null);
    if (isFinishedStatus(progress.runStatus)) return;
    try {
      const body = await patchRun<{ progress: DiscoveryFinderProgress }>("pause_run");
      setProgress(body.progress);
      setMessage("Lead finding paused after the active source request finishes.");
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      router.refresh();
    }
  }

  async function resume() {
    setError(null);
    setRunning(true);
    stopRequested.current = false;
    try {
      const body = await patchRun<{ progress: DiscoveryFinderProgress }>("resume_run");
      setProgress(body.progress);
      setMessage("Lead finding resumed.");
      await runSequentialLoop();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  async function processOne() {
    setError(null);
    setRunning(true);
    stopRequested.current = false;
    try {
      const next = await postJson<DiscoveryNextResult>(
        `/api/500-global/runs/${encodeURIComponent(runId)}/next`,
      );
      setProgress(next.progress);
      setMessage(next.message);
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  async function patchRun<T>(action: string) {
    return requestJson<T>(`/api/500-global/runs/${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  }

  const paused = progress.runStatus === "paused";
  const complete = isFinishedStatus(progress.runStatus);

  return (
    <section className="panel p-6 sm:p-8">
      <p className="eyebrow">Automatic lead finder</p>
      <h2 className="section-title mt-2">Find companies from verified official lists</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
        The finder queues only verified 500 Global participant pages, processes one source per
        request, and saves company-location evidence for review. It does not import founders or
        start email verification.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ProgressStat label="Sources handled" value={`${progress.processedSources} / ${progress.totalSources}`} />
        <ProgressStat label="Companies found" value={progress.discoveredCompanies.toLocaleString()} />
        <ProgressStat label="Needs review" value={progress.needsReviewCompanies.toLocaleString()} />
        <ProgressStat label="Not eligible / rejected" value={progress.rejectedCompanies.toLocaleString()} />
      </div>

      {warnings.map((warning) => (
        <p className="alert alert-warning mt-4" key={warning}>{warning}</p>
      ))}
      {message && <p className="alert mt-4">{message}</p>}
      {error && <p className="alert alert-error mt-4">{error}</p>}

      <div className="mt-6 flex flex-wrap gap-3">
        {!readOnly && !paused && (
          <button className="button button-primary" type="button" onClick={findLeads} disabled={running}>
            {running ? "Finding Leads…" : complete ? "Check Verified Sources Again" : "Find 500 Global Leads"}
          </button>
        )}
        {!readOnly && running && !paused && !complete && (
          <button className="button button-secondary" type="button" onClick={pause}>Pause</button>
        )}
        {!readOnly && paused && (
          <button className="button button-primary" type="button" onClick={resume} disabled={running}>
            {running ? "Resuming…" : "Resume"}
          </button>
        )}
        {progress.discoveredCompanies > 0 && (
          <Link className="button button-success" href={`/500-global/runs/${runId}/review`}>
            Review Found Leads
          </Link>
        )}
      </div>

      {!readOnly && (
        <details className="mt-6 rounded-xl border border-slate-200 p-4">
          <summary className="cursor-pointer text-sm font-bold text-slate-700">Advanced processing control</summary>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Process Next performs exactly one queued source request. Use this for diagnostics or a
            controlled resume after a retry window.
          </p>
          <button className="button button-secondary mt-3" type="button" onClick={processOne} disabled={running || paused}>
            Process Next Source
          </button>
        </details>
      )}
    </section>
  );
}

function ProgressStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-slate-50 p-4"><p className="text-lg font-black text-slate-950">{value}</p><p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p></div>;
}

function postJson<T>(url: string) {
  return requestJson<T>(url, { method: "POST" });
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed.");
  return body;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function isFinishedStatus(status: DiscoveryFinderProgress["runStatus"]) {
  return status === "review_ready" ||
    status === "completed_with_errors" ||
    status === "completed" ||
    status === "cancelled";
}
