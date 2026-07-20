"use client";

import { useState } from "react";

type ExportKind = "smartlead" | "catch_all";

type Props = {
  batchId: string;
  validCount: number;
  catchAllCount: number;
  initialAuthenticated: boolean;
  adminPasswordConfigured: boolean;
};

const EXPORT_CONFIG: Record<
  ExportKind,
  { label: string; loadingLabel: string; filename: string; path: string }
> = {
  smartlead: {
    label: "Export Smartlead CSV",
    loadingLabel: "Preparing Smartlead CSV…",
    filename: "smartlead-export.csv",
    path: "smartlead",
  },
  catch_all: {
    label: "Export Catch-All CSV",
    loadingLabel: "Preparing Catch-All CSV…",
    filename: "catch-all-export.csv",
    path: "catch-all",
  },
};

export function BatchExportButtons({
  batchId,
  validCount,
  catchAllCount,
  initialAuthenticated,
  adminPasswordConfigured,
}: Props) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [requestedKind, setRequestedKind] = useState<ExportKind | null>(null);
  const [downloadingKind, setDownloadingKind] = useState<ExportKind | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function availableCount(kind: ExportKind) {
    return kind === "smartlead" ? validCount : catchAllCount;
  }

  async function requestExport(kind: ExportKind) {
    if (availableCount(kind) === 0 || downloadingKind) return;
    setError(null);

    if (!authenticated) {
      setRequestedKind(kind);
      return;
    }

    await downloadCsv(kind);
  }

  async function authenticateAndDownload() {
    if (isAuthenticating || !password || !requestedKind) return;

    const kind = requestedKind;
    setError(null);
    setIsAuthenticating(true);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) throw new Error(await responseError(response));

      setAuthenticated(true);
      setPassword("");
      setRequestedKind(null);
      await downloadCsv(kind);
    } catch (authenticationError) {
      setError(errorMessage(authenticationError));
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function downloadCsv(kind: ExportKind) {
    const config = EXPORT_CONFIG[kind];
    setError(null);
    setDownloadingKind(kind);
    try {
      const response = await fetch(
        `/api/batches/${encodeURIComponent(batchId)}/export/${config.path}`,
        { method: "GET", credentials: "same-origin", cache: "no-store" },
      );

      if (!response.ok) {
        if (response.status === 401) {
          setAuthenticated(false);
          setRequestedKind(kind);
        }
        throw new Error(await responseError(response));
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = responseFilename(response) ?? config.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setDownloadingKind(null);
    }
  }

  return (
    <div className="flex max-w-xl flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap gap-3 sm:justify-end">
        <ExportButton
          kind="smartlead"
          count={validCount}
          downloadingKind={downloadingKind}
          onClick={requestExport}
        />
        <ExportButton
          kind="catch_all"
          count={catchAllCount}
          downloadingKind={downloadingKind}
          onClick={requestExport}
        />
      </div>

      <p className="max-w-lg text-left text-xs font-medium text-amber-800 sm:text-right">
        Catch-all emails are not confirmed safe and should not be treated as verified contacts.
      </p>
      {validCount === 0 && catchAllCount === 0 && (
        <p className="text-xs text-slate-500">No email candidates are available to export.</p>
      )}
      {error && !requestedKind && (
        <p className="max-w-sm text-left text-xs font-semibold text-red-700 sm:text-right" role="alert">
          {error}
        </p>
      )}

      {requestedKind && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-authentication-title"
          >
            <p className="eyebrow">Administrator access</p>
            <h2 id="export-authentication-title" className="mt-2 text-xl font-bold text-slate-950">
              Authenticate before exporting
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {requestedKind === "catch_all"
                ? "Catch-all candidates are not confirmed safe. Export access requires the existing administrator session."
                : "The CSV contains verified founder contact data and requires the existing administrator session."}
            </p>

            <div className="mt-5">
              <label className="label" htmlFor="export-admin-password">
                Administrator password
              </label>
              <input
                id="export-admin-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={!adminPasswordConfigured || isAuthenticating}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void authenticateAndDownload();
                }}
              />
              {!adminPasswordConfigured && (
                <p className="mt-2 text-xs font-medium text-red-700">
                  Configure FEV_ADMIN_PASSWORD before exporting.
                </p>
              )}
            </div>

            {error && (
              <div className="alert alert-error mt-4" role="alert">{error}</div>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                className="button button-secondary"
                type="button"
                disabled={isAuthenticating}
                onClick={() => {
                  setRequestedKind(null);
                  setPassword("");
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                className="button button-success"
                type="button"
                disabled={!adminPasswordConfigured || !password || isAuthenticating}
                onClick={authenticateAndDownload}
              >
                {isAuthenticating ? "Authenticating…" : "Authenticate and export"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportButton({
  kind,
  count,
  downloadingKind,
  onClick,
}: {
  kind: ExportKind;
  count: number;
  downloadingKind: ExportKind | null;
  onClick: (kind: ExportKind) => Promise<void>;
}) {
  const config = EXPORT_CONFIG[kind];
  const isDownloading = downloadingKind === kind;
  return (
    <button
      className={
        kind === "smartlead"
          ? "button button-success"
          : "button button-secondary border-amber-300 text-amber-900"
      }
      type="button"
      disabled={count === 0 || downloadingKind !== null}
      onClick={() => void onClick(kind)}
    >
      {isDownloading ? config.loadingLabel : config.label}
    </button>
  );
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the safe status-based message.
  }
  return `CSV export failed with HTTP ${response.status}.`;
}

function responseFilename(response: Response) {
  const disposition = response.headers.get("content-disposition");
  const match = disposition?.match(/filename="([^"\\/]+)"/i);
  return match?.[1];
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not create the CSV export.";
}
