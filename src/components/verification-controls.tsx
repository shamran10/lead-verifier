"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { StatusPill } from "@/components/status-pill";
import type {
  VerificationProgress,
  VerificationStepResult,
} from "@/lib/types";

type Props = {
  batchId: string;
  initialProgress: VerificationProgress;
  initialAuthenticated: boolean;
  adminPasswordConfigured: boolean;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error ?? "Verification request failed.");
    Object.assign(error, { status: response.status });
    throw error;
  }
  return body;
}

function isCompleted(status: string) {
  return status === "completed" || status === "completed_with_errors";
}

export function VerificationControls({
  batchId,
  initialProgress,
  initialAuthenticated,
  adminPasswordConfigured,
}: Props) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationAction, setConfirmationAction] = useState<"start" | "retry">("start");
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const continueRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      continueRef.current = false;
      requestControllerRef.current?.abort();
    };
  }, []);

  async function unlockAdminSession() {
    if (authenticated) return;

    const response = await fetch("/api/admin/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    await readJson<{ authenticated: true }>(response);
    setAuthenticated(true);
    setPassword("");
  }

  async function confirmAndRun() {
    if (isStarting || runningRef.current) return;

    setError(null);
    setIsStarting(true);
    try {
      await unlockAdminSession();

      if (confirmationAction === "retry") {
        const response = await fetch(
          `/api/batches/${encodeURIComponent(batchId)}/verification/retry`,
          { method: "POST", credentials: "same-origin" },
        );
        const step = await readJson<VerificationStepResult>(response);
        setProgress(step.progress);
        setShowConfirmation(false);
        router.refresh();
        if (step.progress.status === "verifying") {
          void runVerificationLoop(step.progress);
        }
        return;
      }

      const response = await fetch(
        `/api/batches/${encodeURIComponent(batchId)}/verification`,
        { method: "POST", credentials: "same-origin" },
      );
      const startedProgress = await readJson<VerificationProgress>(response);
      setProgress(startedProgress);
      setShowConfirmation(false);
      router.refresh();

      if (startedProgress.status === "verifying") {
        void runVerificationLoop(startedProgress);
      }
    } catch (startError) {
      handleRequestError(startError);
    } finally {
      setIsStarting(false);
    }
  }

  function handleRequestError(requestError: unknown) {
    const status =
      requestError instanceof Error && "status" in requestError
        ? (requestError as Error & { status: number }).status
        : null;
    if (status === 401) setAuthenticated(false);
    setError(
      requestError instanceof Error
        ? requestError.message
        : "Verification request failed.",
    );
  }

  async function runVerificationLoop(startingProgress: VerificationProgress) {
    if (runningRef.current) return;

    runningRef.current = true;
    continueRef.current = true;
    setIsRunning(true);
    setError(null);
    let currentProgress = startingProgress;

    try {
      while (
        continueRef.current &&
        currentProgress.status === "verifying"
      ) {
        const controller = new AbortController();
        requestControllerRef.current = controller;
        const previousProcessed = currentProgress.processedFounders;
        const response = await fetch(
          `/api/batches/${encodeURIComponent(batchId)}/verification/next`,
          {
            method: "POST",
            credentials: "same-origin",
            signal: controller.signal,
          },
        );
        const step = await readJson<VerificationStepResult>(response);
        currentProgress = step.progress;
        setProgress(currentProgress);

        if (currentProgress.processedFounders !== previousProcessed) {
          router.refresh();
        }

        if (step.outcome === "busy" && currentProgress.status === "verifying") {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
      }
    } catch (loopError) {
      if (!(loopError instanceof Error && loopError.name === "AbortError")) {
        handleRequestError(loopError);
      }
    } finally {
      requestControllerRef.current = null;
      continueRef.current = false;
      runningRef.current = false;
      setIsRunning(false);
      router.refresh();
    }
  }

  async function retryFailedVerification() {
    if (isRetrying || runningRef.current) return;

    if (!authenticated) {
      setError(null);
      setConfirmationAction("retry");
      setShowConfirmation(true);
      return;
    }

    setError(null);
    setIsRetrying(true);
    try {
      await unlockAdminSession();
      const response = await fetch(
        `/api/batches/${encodeURIComponent(batchId)}/verification/retry`,
        { method: "POST", credentials: "same-origin" },
      );
      const step = await readJson<VerificationStepResult>(response);
      setProgress(step.progress);
      router.refresh();

      if (step.progress.status === "verifying") {
        void runVerificationLoop(step.progress);
      }
    } catch (retryError) {
      handleRequestError(retryError);
    } finally {
      setIsRetrying(false);
    }
  }

  function pauseVerification() {
    continueRef.current = false;
    requestControllerRef.current?.abort();
  }

  const canStartOrResume =
    !isCompleted(progress.status) && progress.totalFounders > 0;
  const actionLabel = progress.status === "verifying" ? "Resume Verification" : "Start Verification";

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-col gap-5 px-6 py-6 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="section-title">Verification progress</h2>
            <StatusPill status={progress.status} />
          </div>
          <div className="progress-track mt-4" aria-label={`${progress.percentComplete}% complete`}>
            <div
              className="progress-value"
              style={{ width: `${progress.percentComplete}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {progress.processedFounders} of {progress.totalFounders} founders processed · {progress.attemptCount} candidate attempts
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {isRunning ? (
            <button className="button button-secondary" type="button" onClick={pauseVerification}>
              Pause after current check
            </button>
          ) : (
            <button
              className="button button-primary"
              type="button"
              disabled={!canStartOrResume || isStarting}
              onClick={() => {
                setError(null);
                setConfirmationAction("start");
                setShowConfirmation(true);
              }}
            >
              {actionLabel}
            </button>
          )}
          {!isRunning && progress.errorAttemptCount > 0 && (
            <button
              className="button button-secondary"
              type="button"
              disabled={isRetrying || isStarting}
              onClick={retryFailedVerification}
            >
              {isRetrying ? "Retrying…" : "Retry Failed Verification"}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-px border-t border-slate-200 bg-slate-200 sm:grid-cols-4">
        <ProgressMetric label="Valid" value={progress.validEmails} />
        <ProgressMetric label="No valid email" value={progress.noValidEmails} />
        <ProgressMetric label="Errors" value={progress.errorFounders} />
        <ProgressMetric label="Remaining" value={progress.remainingFounders} />
      </div>

      {error && (
        <div className="alert alert-error m-5 sm:m-6" role="alert">
          <strong>Verification paused.</strong> {error}
        </div>
      )}

      {progress.errors.length > 0 && (
        <details className="border-t border-slate-200 px-6 py-5 sm:px-8">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">
            Review {progress.errorAttemptCount} verification errors
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            {progress.errors.map((item) => (
              <li key={`${item.founderId}-${item.candidateEmail}-${item.attemptedAt}`}>
                <span className="font-mono text-xs text-slate-800">{item.candidateEmail}</span>: {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {showConfirmation && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="verification-confirm-title">
            <p className="eyebrow">Credit confirmation</p>
            <h2 id="verification-confirm-title" className="mt-2 text-xl font-bold text-slate-950">
              {confirmationAction === "retry"
                ? "Retry one failed Reoon verification?"
                : "Start sequential Reoon verification?"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {confirmationAction === "retry"
                ? "One failed provider or malformed-response attempt will be rechecked in Reoon Power mode. Conclusive results cannot be retried."
                : "Reoon Power-mode credits will be used. Each request checks one candidate, first-name candidates are always checked first, and a valid safe result stops that founder immediately."}
            </p>

            {!authenticated && (
              <div className="mt-5">
                <label className="label" htmlFor="admin-password">
                  Administrator password
                </label>
                <input
                  id="admin-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={!adminPasswordConfigured}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {!adminPasswordConfigured && (
                  <p className="mt-2 text-xs font-medium text-red-700">
                    Configure FEV_ADMIN_PASSWORD before verification can start.
                  </p>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                className="button button-secondary"
                type="button"
                disabled={isStarting}
                onClick={() => setShowConfirmation(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={
                  isStarting ||
                  (!authenticated && (!adminPasswordConfigured || !password))
                }
                onClick={confirmAndRun}
              >
                {isStarting ? "Starting…" : "Confirm and use credits"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProgressMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white px-6 py-4 sm:px-8">
      <p className="text-xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
    </div>
  );
}
