"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type Props = {
  initialAuthenticated: boolean;
  adminPasswordConfigured: boolean;
  showCreateForm?: boolean;
};

export function FiveHundredGlobalRunControls({
  initialAuthenticated,
  adminPasswordConfigured,
  showCreateForm = true,
}: Props) {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [years, setYears] = useState<number[]>([2025, 2026]);
  const [regions, setRegions] = useState<string[]>(["europe", "north_america"]);
  const [maxRecords, setMaxRecords] = useState(250);
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      await readJson(response);
      setAuthenticated(true);
      setPassword("");
      router.refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function createRun(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/500-global/runs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          targetYears: years,
          targetRegions: regions,
          maxRecords,
          dryRun,
        }),
      });
      const body = await readJson<{ run: { id: string } }>(response);
      router.push(`/500-global/runs/${encodeURIComponent(body.run.id)}`);
      router.refresh();
    } catch (requestError) {
      if (requestError instanceof RequestError && requestError.status === 401) {
        setAuthenticated(false);
      }
      setError(messageOf(requestError));
    } finally {
      setBusy(false);
    }
  }

  if (!authenticated) {
    return (
      <form className="panel max-w-xl p-6" onSubmit={unlock}>
        <h2 className="section-title">Administrator access</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Discovery pages and actions require the existing administrator session.
        </p>
        <label className="label mt-5" htmlFor="discovery-admin-password">
          Administrator password
        </label>
        <input
          id="discovery-admin-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={!adminPasswordConfigured || busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        {!adminPasswordConfigured && (
          <p className="mt-2 text-sm font-medium text-red-700">
            FEV_ADMIN_PASSWORD is not configured.
          </p>
        )}
        {error && <p className="alert alert-error mt-4">{error}</p>}
        <button
          className="button button-primary mt-5"
          type="submit"
          disabled={busy || !password || !adminPasswordConfigured}
        >
          {busy ? "Unlocking…" : "Unlock Lead Finder"}
        </button>
      </form>
    );
  }

  if (!showCreateForm) return null;

  return (
    <form className="panel p-6 sm:p-8" onSubmit={createRun}>
      <div>
        <p className="eyebrow">Create run</p>
        <h2 className="section-title mt-2">Set a bounded discovery scope</h2>
      </div>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="discovery-run-name">Run name</label>
          <input
            id="discovery-run-name"
            className="input"
            maxLength={120}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="500 Global 2025–2026 review"
          />
        </div>
        <CheckboxGroup
          label="Target years"
          values={years.map(String)}
          options={[{ value: "2025", label: "2025" }, { value: "2026", label: "2026" }]}
          onChange={(values) => setYears(values.map(Number))}
        />
        <CheckboxGroup
          label="Company regions"
          values={regions}
          options={[
            { value: "europe", label: "Europe" },
            { value: "north_america", label: "North America" },
          ]}
          onChange={setRegions}
        />
        <div>
          <label className="label" htmlFor="discovery-max-records">Maximum records</label>
          <input
            id="discovery-max-records"
            className="input"
            type="number"
            min={1}
            max={1000}
            required
            value={maxRecords}
            onChange={(event) => setMaxRecords(Number(event.target.value))}
          />
          <p className="mt-2 text-xs text-slate-500">Hard maximum: 1,000.</p>
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4">
          <input
            className="mt-1"
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          <span>
            <span className="block text-sm font-bold text-slate-800">Dry run</span>
            <span className="mt-1 block text-xs leading-5 text-slate-500">
              Preview and review only. Dry runs cannot import a batch.
            </span>
          </span>
        </label>
      </div>
      {error && <p className="alert alert-error mt-5">{error}</p>}
      <button className="button button-primary mt-6" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create Run"}
      </button>
    </form>
  );
}

function CheckboxGroup({ label, values, options, onChange }: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold">
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option.value]
                    : values.filter((value) => value !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

class RequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function readJson<T = unknown>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new RequestError(body.error ?? "Request failed.", response.status);
  return body;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}
