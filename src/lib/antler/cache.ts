import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assertSafeDerivedValue } from "@/lib/antler/cache-serialization";

const CACHE_VERSION = 1 as const;
const CACHE_MARKER_FILE = ".antler-exporter-cache";
const CACHE_MARKER = "founder-email-verifier:antler-exporter-cache:v1\n";

export type AntlerCacheStatus =
  | "pending"
  | "processing"
  | "completed"
  | "retry_wait"
  | "failed";

export type AntlerCacheItem<T = unknown> = {
  status: AntlerCacheStatus;
  attempts: number;
  value: T | null;
  error: string | null;
  retry_at: string | null;
  updated_at: string;
};

type CacheDocument = {
  version: typeof CACHE_VERSION;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  sources: Record<string, AntlerCacheItem>;
  companies: Record<string, AntlerCacheItem>;
};

export function antlerOptionsFingerprint(value: unknown) {
  assertSafeDerivedValue(value, "options");
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function openAntlerCache(input: {
  directory: string;
  fingerprint: string;
  fresh: boolean;
}) {
  const directory = path.resolve(input.directory);
  assertAntlerCachePath(directory);
  if (input.fresh) await resetAntlerCache(directory);
  await ensureCacheDirectory(directory);
  const filePath = path.join(directory, "state.json");
  let document = await readDocument(filePath);
  if (!document) {
    const now = new Date().toISOString();
    document = {
      version: CACHE_VERSION,
      fingerprint: input.fingerprint,
      created_at: now,
      updated_at: now,
      sources: {},
      companies: {},
    };
    const cache = new AntlerCache(directory, document);
    await cache.save();
    return cache;
  }
  if (document.fingerprint !== input.fingerprint) {
    throw new Error("The Antler cache belongs to different options. Rerun with --fresh.");
  }
  let recovered = false;
  for (const bucket of [document.sources, document.companies]) {
    for (const item of Object.values(bucket)) {
      if (item.status === "processing") {
        item.status = "pending";
        item.error = "Interrupted work was returned to pending.";
        recovered = true;
      }
    }
  }
  const cache = new AntlerCache(directory, document);
  if (recovered) await cache.save();
  return cache;
}

export class AntlerCache {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    public readonly directory: string,
    private readonly document: CacheDocument,
  ) {}

  get<T>(bucket: "sources" | "companies", key: string) {
    return this.document[bucket][key] as AntlerCacheItem<T> | undefined;
  }

  entries<T>(bucket: "sources" | "companies") {
    return Object.values(this.document[bucket]) as AntlerCacheItem<T>[];
  }

  markProcessing(bucket: "sources" | "companies", key: string) {
    const existing = this.document[bucket][key];
    this.document[bucket][key] = {
      status: "processing",
      attempts: (existing?.attempts ?? 0) + 1,
      value: existing?.value ?? null,
      error: null,
      retry_at: null,
      updated_at: new Date().toISOString(),
    };
  }

  set<T>(
    bucket: "sources" | "companies",
    key: string,
    status: Exclude<AntlerCacheStatus, "processing">,
    value: T | null,
    error: string | null = null,
    retryAt: string | null = null,
  ) {
    assertSafeDerivedValue(value, `${bucket}.${key}`);
    const existing = this.document[bucket][key];
    this.document[bucket][key] = {
      status,
      attempts: existing?.attempts ?? 1,
      value,
      error,
      retry_at: retryAt,
      updated_at: new Date().toISOString(),
    };
  }

  async save() {
    this.writeChain = this.writeChain.then(async () => {
      this.document.updated_at = new Date().toISOString();
      assertSafeDerivedValue(this.document, "cache");
      const filePath = path.join(this.directory, "state.json");
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await replaceFileWithRetry(temporaryPath, filePath);
    });
    return this.writeChain;
  }
}

export async function replaceFileWithRetry(source: string, destination: string) {
  try {
    await rename(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EEXIST", "EPERM", "EACCES"].includes(code ?? "")) throw error;
    await rm(destination, { force: true });
    await rename(source, destination);
  }
}

async function resetAntlerCache(directory: string) {
  const stat = await safeLstat(directory);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Refusing to reset an Antler cache path that is not a real directory.");
    }
    const marker = await readFile(path.join(directory, CACHE_MARKER_FILE), "utf8").catch(() => "");
    if (marker !== CACHE_MARKER) {
      throw new Error("Refusing to reset an unmarked Antler cache directory.");
    }
    await rm(directory, { recursive: true, force: true });
  }
  await ensureCacheDirectory(directory);
}

async function ensureCacheDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
  const markerPath = path.join(directory, CACHE_MARKER_FILE);
  const marker = await readFile(markerPath, "utf8").catch(() => "");
  if (marker && marker !== CACHE_MARKER) {
    throw new Error("The Antler cache marker is invalid.");
  }
  if (!marker) await writeFile(markerPath, CACHE_MARKER, { encoding: "utf8", mode: 0o600 });
}

async function readDocument(filePath: string) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as CacheDocument;
    if (
      value.version !== CACHE_VERSION ||
      typeof value.fingerprint !== "string" ||
      !value.sources ||
      !value.companies
    ) {
      throw new Error("The Antler cache has an unsupported structure.");
    }
    assertSafeDerivedValue(value, "cache");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function safeLstat(value: string) {
  try {
    return await lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertAntlerCachePath(directory: string) {
  const normalized = directory.replace(/\\/g, "/").toLowerCase();
  if (!normalized.endsWith("/.cache/antler") && !normalized.includes("/.cache/antler/")) {
    throw new Error("Antler cache paths must stay under .cache/antler.");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
