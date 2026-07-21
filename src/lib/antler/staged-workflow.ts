import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { replaceFileWithRetry } from "@/lib/antler/cache";
import { assertSafeDerivedValue } from "@/lib/antler/cache-serialization";
import type {
  DiscoveredAntlerDocument,
  FilteredAntlerDocument,
} from "@/lib/antler/types";

export const ANTLER_STAGE_SCHEMA_VERSION = 1 as const;

export function discoveredDatasetPath() {
  return path.resolve(process.cwd(), ".cache", "antler", "discovered-companies.json");
}

export function filteredDatasetPath() {
  return path.resolve(process.cwd(), ".cache", "antler", "filtered-companies.json");
}

export async function readDiscoveredDocument() {
  const value = await readStageDocument<DiscoveredAntlerDocument>(
    discoveredDatasetPath(),
    "discover",
  );
  if (!Array.isArray(value.companies) || !Array.isArray(value.years)) {
    throw new Error("The Antler discovery dataset is malformed.");
  }
  return value;
}

export async function readFilteredDocument() {
  const value = await readStageDocument<FilteredAntlerDocument>(
    filteredDatasetPath(),
    "filter",
  );
  if (!Array.isArray(value.companies) || !Array.isArray(value.regions)) {
    throw new Error("The Antler filtered dataset is malformed.");
  }
  return value;
}

export async function writeStageDocument(
  filePath: string,
  value: DiscoveredAntlerDocument | FilteredAntlerDocument,
) {
  assertSafeDerivedValue(value, value.stage);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await replaceFileWithRetry(temporaryPath, filePath);
}

async function readStageDocument<T extends { schema_version: 1; stage: string }>(
  filePath: string,
  stage: string,
) {
  let value: T;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Missing Antler ${stage} dataset. Run npm run lead:antler:${stage === "filter" ? "filter" : "discover"} first.`,
      );
    }
    throw error;
  }
  if (value.schema_version !== ANTLER_STAGE_SCHEMA_VERSION || value.stage !== stage) {
    throw new Error(`The Antler ${stage} dataset has an unsupported schema.`);
  }
  assertSafeDerivedValue(value, stage);
  return value;
}
