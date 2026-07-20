import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { replaceCacheFileWithRetry } from "@/lib/techstars/exporter-cache";

export async function writeWorkbookAtomically(
  outputPath: string,
  write: (temporaryPath: string) => Promise<void>,
) {
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp.xlsx`;
  try {
    await write(temporaryPath);
    await replaceCacheFileWithRetry(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (isWindowsFileLock(error)) {
      throw new Error(
        `The output workbook is open or locked: ${outputPath}. Close it in Excel and disable any File Explorer preview, then rerun this stage with --resume.`,
      );
    }
    throw error;
  }
}

function isWindowsFileLock(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}
