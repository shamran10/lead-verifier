"use client";

import Link from "next/link";
import { useState } from "react";

import {
  sourceTypeLabel,
  type ImportResult,
  type PreviewResult,
  type SourceType,
} from "@/lib/types";

function deriveBatchName(fileName: string) {
  return fileName
    .replace(/\.xlsx$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "The request failed.");
  }
  return body;
}

export function UploadWorkflow() {
  const [sourceType, setSourceType] = useState<SourceType>("yc");
  const [file, setFile] = useState<File | null>(null);
  const [batchName, setBatchName] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  function chooseFile(selectedFile: File | null) {
    setFile(selectedFile);
    setPreview(null);
    setResult(null);
    setError(null);
    if (selectedFile) {
      setBatchName(deriveBatchName(selectedFile.name));
    }
  }

  function chooseSource(nextSourceType: SourceType) {
    setSourceType(nextSourceType);
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function previewWorkbook() {
    if (!file) return;

    setError(null);
    setResult(null);
    setIsPreviewing(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("sourceType", sourceType);
      const response = await fetch("/api/upload/preview", {
        method: "POST",
        body: formData,
      });
      setPreview(await readJson<PreviewResult>(response));
    } catch (previewError) {
      setPreview(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Could not preview the workbook.",
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function confirmImport() {
    if (!file || !preview || !batchName.trim()) return;

    setError(null);
    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("batchName", batchName.trim());
      formData.set("sourceType", sourceType);
      const response = await fetch("/api/upload/import", {
        method: "POST",
        body: formData,
      });
      setResult(await readJson<ImportResult>(response));
      setPreview(null);
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Could not import the workbook.",
      );
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel p-6 sm:p-8">
        <div className="mb-6 border-b border-slate-200 pb-6">
          <fieldset>
            <legend className="label">Import source</legend>
            <div className="flex flex-wrap gap-3">
              <SourceOption
                checked={sourceType === "yc"}
                label="Y Combinator"
                value="yc"
                onChange={chooseSource}
              />
              <SourceOption
                checked={sourceType === "500_global"}
                label="500 Global"
                value="500_global"
                onChange={chooseSource}
              />
              <SourceOption
                checked={sourceType === "techstars"}
                label="Techstars"
                value="techstars"
                onChange={chooseSource}
              />
            </div>
          </fieldset>
          <p className="mt-3 text-sm text-slate-600">
            {sourceDescription(sourceType)}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <label className="label" htmlFor="workbook">
              XLSX workbook
            </label>
            <label className="file-picker" htmlFor="workbook">
              <span className="file-icon" aria-hidden="true">
                ↑
              </span>
              <span>
                <span className="block font-semibold text-slate-900">
                  {file ? file.name : "Choose an XLSX file"}
                </span>
                <span className="mt-1 block text-sm text-slate-500">
                  Multiple sheets are supported · maximum 15 MB
                </span>
              </span>
            </label>
            <input
              id="workbook"
              className="sr-only"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <div>
            <label className="label" htmlFor="batch-name">
              Batch name
            </label>
            <input
              id="batch-name"
              className="input"
              value={batchName}
              maxLength={120}
              placeholder={sourcePlaceholder(sourceType)}
              onChange={(event) => setBatchName(event.target.value)}
            />
            <p className="mt-2 text-xs text-slate-500">
              Derived from the filename; edit it before importing if needed.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-6">
          <button
            className="button button-primary"
            type="button"
            disabled={!file || isPreviewing || isImporting}
            onClick={previewWorkbook}
          >
            {isPreviewing ? "Reading workbook…" : "Preview founders"}
          </button>
          {preview && (
            <button
              className="button button-success"
              type="button"
              disabled={!batchName.trim() || isImporting}
              onClick={confirmImport}
            >
              {isImporting ? "Importing…" : "Confirm import"}
            </button>
          )}
          <span className="text-sm text-slate-500">
            Nothing is written until you confirm.
          </span>
        </div>
      </section>

      {error && (
        <div className="alert alert-error" role="alert">
          <strong>Could not continue.</strong> {error}
        </div>
      )}

      {result && (
        <section className="panel overflow-hidden">
          <div className="border-b border-emerald-100 bg-emerald-50 px-6 py-5 sm:px-8">
            <p className="text-lg font-bold text-emerald-950">Batch imported</p>
            <p className="mt-1 text-sm text-emerald-800">
              Status is parsed. No email verification has started.
            </p>
          </div>
          <div className="grid gap-px bg-slate-200 sm:grid-cols-3">
            <ResultMetric label="Inserted" value={result.insertedCount} />
            <ResultMetric label="Duplicates skipped" value={result.duplicateCount} />
            <ResultMetric label="Invalid rows" value={result.invalidRowCount} />
          </div>
          <div className="flex flex-wrap items-center gap-3 px-6 py-5 sm:px-8">
            <Link
              className="button button-primary"
              href={`/batches/${result.batchId}`}
            >
              Review extracted founders
            </Link>
            <Link className="button button-secondary" href="/batches">
              View all batches
            </Link>
          </div>
        </section>
      )}

      {preview && (
        <section className="panel overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <h2 className="text-lg font-bold text-slate-950">Import preview</h2>
              <p className="mt-1 text-sm text-slate-500">
                {sourceTypeLabel(preview.sourceType)}
                {" · "}Processed {preview.processedSheets.join(", ")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <PreviewBadge label="Companies" value={preview.companyCount} />
              <PreviewBadge label="Ready" value={preview.readyCount} />
              <PreviewBadge label="Duplicates" value={preview.duplicateCount} />
              <PreviewBadge label="Invalid rows" value={preview.invalidRowCount} />
            </div>
          </div>

          {preview.skippedSheets.length > 0 && (
            <div className="alert alert-warning m-5 sm:m-6">
              Skipped sheets without the expected headers: {" "}
              {preview.skippedSheets.join(", ")}.
            </div>
          )}

          {preview.sourceType === "500_global" && (
            <div className="alert alert-warning m-5 sm:m-6">
              Geography is based on the company headquarters/current country,
              not the accelerator program location. Review each official source
              URL before importing. Verification will not start automatically.
            </div>
          )}

          {preview.sourceType === "techstars" && (
            <div className="alert alert-warning m-5 sm:m-6">
              Geography is based on the company headquarters/current country,
              not the Techstars program location. Review each official source
              URL before importing. Verification will not start automatically.
            </div>
          )}

          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Founder</th>
                  <th>Domain</th>
                  <th>
                    {preview.sourceType === "yc" ? "YC batch" : "Accelerator"}
                  </th>
                  <th>First candidate</th>
                  <th>Last candidate</th>
                  <th>Source</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.founders.map((founder, index) => (
                  <tr
                    className={
                      founder.status === "duplicate" ? "bg-amber-50/50" : ""
                    }
                    key={`${founder.sourceSheetName}-${founder.sourceRow}-${founder.normalizedFounderName}-${index}`}
                  >
                    <td className="font-semibold text-slate-900">
                      {founder.companyName}
                    </td>
                    <td>
                      <p className="font-semibold text-slate-900">
                        {founder.founderName}
                      </p>
                      {founder.founderRole && (
                        <p className="mt-1 text-xs text-slate-500">
                          {founder.founderRole}
                        </p>
                      )}
                    </td>
                    <td>{founder.normalizedDomain}</td>
                    <td>
                      {preview.sourceType === "yc" ? (
                        founder.ycBatch ?? "—"
                      ) : (
                        <div className="min-w-52 text-xs text-slate-600">
                          <p className="font-semibold text-slate-900">
                            {founder.acceleratorName}
                          </p>
                          <p className="mt-1">
                            {[founder.acceleratorBatch, founder.acceleratorYear]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                          </p>
                          <p className="mt-1">
                            {founder.country} · {formatRegion(founder.acceleratorRegion)}
                          </p>
                          {founder.sourceUrl && (
                            <a
                              className="mt-1 block max-w-64 truncate font-semibold text-indigo-700 hover:text-indigo-900"
                              href={founder.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Review official source
                            </a>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {founder.firstCandidateEmail}
                    </td>
                    <td className="font-mono text-xs">
                      {founder.lastCandidateEmail ?? "—"}
                    </td>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {founder.sourceSheetName} · row {founder.sourceRow}
                    </td>
                    <td>
                      <span
                        className={
                          founder.status === "ready"
                            ? "status-ready"
                            : "status-duplicate"
                        }
                      >
                        {founder.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.founders.length === 0 && (
              <div className="empty-state rounded-none border-0">
                No importable founders were found.
              </div>
            )}
          </div>

          {preview.invalidRows.length > 0 && (
            <details className="border-t border-slate-200 px-6 py-5 sm:px-8">
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                Review {preview.invalidRowCount} invalid source rows
              </summary>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                {preview.invalidRows.map((row) => (
                  <li key={`${row.sourceSheetName}-${row.sourceRow}`}>
                    <span className="font-medium text-slate-800">
                      {row.sourceSheetName}, row {row.sourceRow}:
                    </span>{" "}
                    {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

function SourceOption({
  checked,
  label,
  value,
  onChange,
}: {
  checked: boolean;
  label: string;
  value: SourceType;
  onChange: (value: SourceType) => void;
}) {
  return (
    <label
      className={`cursor-pointer rounded-lg border px-4 py-3 text-sm font-semibold ${
        checked
          ? "border-indigo-500 bg-indigo-50 text-indigo-900"
          : "border-slate-200 bg-white text-slate-700"
      }`}
    >
      <input
        className="sr-only"
        type="radio"
        name="source-type"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      {label}
    </label>
  );
}

function formatRegion(value: "europe" | "north_america" | null) {
  if (value === "north_america") return "North America";
  if (value === "europe") return "Europe";
  return "—";
}

function sourceDescription(sourceType: SourceType) {
  if (sourceType === "yc") {
    return "YC imports keep the existing workbook, validation, and export behavior.";
  }
  if (sourceType === "techstars") {
    return "Techstars eligibility uses the company headquarters/current country and official Techstars participation evidence.";
  }
  return "500 Global eligibility uses the company headquarters/current country. The official source URL must be reviewed manually.";
}

function sourcePlaceholder(sourceType: SourceType) {
  if (sourceType === "yc") return "e.g. YC S26 founders";
  if (sourceType === "techstars") return "e.g. Techstars 2026 founders";
  return "e.g. 500 Global 2026 founders";
}

function PreviewBadge({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">
      {label}: {value}
    </span>
  );
}

function ResultMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white px-6 py-5 sm:px-8">
      <p className="text-2xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
    </div>
  );
}
