"use client";

import { useState } from "react";

type Props = {
  batchId: string;
  validCount: number;
  initialAuthenticated: boolean;
  adminPasswordConfigured: boolean;
};

export function SmartleadExportButton({
  batchId,
  validCount,
  initialAuthenticated,
  adminPasswordConfigured,
}: Props) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [showAuthentication, setShowAuthentication] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = validCount === 0 || isDownloading;

  async function requestExport() {
    if (disabled) return;
    setError(null);

    if (!authenticated) {
      setShowAuthentication(true);
      return;
    }

    await downloadCsv();
  }

  async function authenticateAndDownload() {
    if (isAuthenticating || !password) return;

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
      setShowAuthentication(false);
      await downloadCsv();
    } catch (authenticationError) {
      setError(errorMessage(authenticationError));
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function downloadCsv() {
    setError(null);
    setIsDownloading(true);
    try {
      const response = await fetch(
        `/api/batches/${encodeURIComponent(batchId)}/export/smartlead`,
        { method: "GET", credentials: "same-origin", cache: "no-store" },
      );

      if (!response.ok) {
        if (response.status === 401) {
          setAuthenticated(false);
          setShowAuthentication(true);
        }
        throw new Error(await responseError(response));
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = responseFilename(response) ?? "smartlead-export.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        className="button button-success"
        type="button"
        disabled={disabled}
        onClick={requestExport}
      >
        {isDownloading ? "Preparing CSV…" : "Export Smartlead CSV"}
      </button>

      {validCount === 0 && (
        <p className="text-xs text-slate-500">No valid emails are available to export.</p>
      )}
      {error && (
        <p className="max-w-sm text-left text-xs font-semibold text-red-700 sm:text-right" role="alert">
          {error}
        </p>
      )}

      {showAuthentication && (
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
              The CSV contains verified founder contact data and requires the existing administrator session.
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
                  setShowAuthentication(false);
                  setPassword("");
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
    : "Could not create the Smartlead CSV export.";
}
