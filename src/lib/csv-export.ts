import "server-only";

export type CsvValue = string | null;

export function displayNameParts(founderName: string) {
  const parts = founderName.trim().split(/\s+/u).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
  };
}

export function createCsv(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<CsvValue>>,
) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function exportFilename(prefix: string, batchName: string) {
  const safePrefix = asciiSlug(prefix) || "export";
  const batchSlug = asciiSlug(batchName).slice(0, 60).replace(/-+$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  return `${safePrefix}-${batchSlug || "batch"}-${date}.csv`;
}

function csvCell(value: CsvValue) {
  const text = preventSpreadsheetFormula(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function preventSpreadsheetFormula(value: string) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function asciiSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
