import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertSafeSerializedSourceCacheValue,
  serializeSourceWorkResultForCache,
} from "@/lib/500-global/source-cache-serialization";

export const EXPORTER_CACHE_VERSION = 1 as const;
export const EXPORTER_CACHE_FILE = "state.json";

const CACHE_MARKER_FILE = ".500-global-exporter-cache";
const CACHE_MARKER =
  "founder-email-verifier:500-global-exporter-cache:v1\n";
const CACHE_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const RETRYABLE_CACHE_REPLACE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export type ExporterCacheBucket = "sources" | "companies";
export type ExporterCacheStatus =
  | "pending"
  | "processing"
  | "completed"
  | "retry_wait"
  | "failed";

export type ExporterCacheItem<T = unknown> = {
  status: ExporterCacheStatus;
  attempts: number;
  value: T | null;
  error: string | null;
  retryAt: string | null;
  updatedAt: string;
};

export type ExporterCacheDocument = {
  version: typeof EXPORTER_CACHE_VERSION;
  optionsFingerprint: string;
  createdAt: string;
  updatedAt: string;
  sources: Record<string, ExporterCacheItem>;
  companies: Record<string, ExporterCacheItem>;
  coverageWarnings: string[];
};

export class ExporterCacheError extends Error {}

export class ExporterCacheFingerprintError extends ExporterCacheError {}

type OpenExporterCacheOptions = {
  directory: string;
  optionsFingerprint: string;
  fresh?: boolean;
  now?: () => number;
};

type SetCacheItemInput<T> = {
  status: ExporterCacheStatus;
  attempts?: number;
  value?: T | null;
  error?: string | null;
  retryAt?: string | null;
};

export function createOptionsFingerprint(options: unknown) {
  assertSafeCacheValue(options, "options");
  return createHash("sha256")
    .update(stableStringify(options))
    .digest("hex");
}

export async function openExporterCache(
  options: OpenExporterCacheOptions,
): Promise<ExporterCache> {
  assertFingerprint(options.optionsFingerprint);
  const directory = resolve(options.directory);
  if (options.fresh) {
    await resetExporterCache(directory);
  } else {
    await ensureCacheDirectory(directory);
  }

  const now = options.now ?? Date.now;
  const filePath = resolve(directory, EXPORTER_CACHE_FILE);
  const loaded = await readCacheDocument(filePath);
  if (!loaded) {
    const createdAt = new Date(now()).toISOString();
    const cache = new ExporterCache(
      directory,
      {
        version: EXPORTER_CACHE_VERSION,
        optionsFingerprint: options.optionsFingerprint,
        createdAt,
        updatedAt: createdAt,
        sources: {},
        companies: {},
        coverageWarnings: [],
      },
      now,
    );
    await cache.save();
    return cache;
  }

  const migrated = migrateLegacySourceEntries(loaded);
  validateCacheDocument(loaded);
  if (loaded.optionsFingerprint !== options.optionsFingerprint) {
    throw new ExporterCacheFingerprintError(
      "The cache belongs to different exporter options. Use --fresh to start again.",
    );
  }

  const cache = new ExporterCache(directory, loaded, now);
  if (migrated || cache.recoverInterruptedWork()) await cache.save();
  return cache;
}

export async function resetExporterCache(directoryInput: string) {
  const directory = resolve(directoryInput);
  assertSafeCacheDirectory(directory);

  const existing = await safeLstat(directory);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new ExporterCacheError(
        "Refusing to reset a cache path that is not a real directory.",
      );
    }
    await assertCacheMarker(directory);
    await rm(directory, { recursive: true, force: true });
  }

  await ensureCacheDirectory(directory);
}

export class ExporterCache {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    public readonly directory: string,
    private document: ExporterCacheDocument,
    private readonly now: () => number,
  ) {}

  snapshot(): ExporterCacheDocument {
    return cloneJson(this.document);
  }

  get<T = unknown>(
    bucket: ExporterCacheBucket,
    key: string,
  ): ExporterCacheItem<T> | null {
    const item = this.document[bucket][key];
    return item ? (cloneJson(item) as ExporterCacheItem<T>) : null;
  }

  set<T>(
    bucket: ExporterCacheBucket,
    key: string,
    input: SetCacheItemInput<T>,
  ) {
    assertCacheKey(key);
    if (bucket === "sources" && input.value !== undefined && input.value !== null) {
      try {
        assertSafeSerializedSourceCacheValue(input.value);
      } catch (error) {
        throw new ExporterCacheError(
          error instanceof Error
            ? error.message
            : "Source cache values must use the explicit safe serialized schema.",
        );
      }
    }
    assertSafeCacheValue(input.value ?? null, `${bucket}.${key}.value`);
    const previous = this.document[bucket][key];
    const attempts = input.attempts ?? previous?.attempts ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new ExporterCacheError("Cache attempt counts must be non-negative integers.");
    }
    const retryAt = normalizeRetryAt(input.retryAt ?? null);
    if (input.status === "retry_wait" && !retryAt) {
      throw new ExporterCacheError("Retry-wait cache entries require retryAt.");
    }

    this.document[bucket][key] = {
      status: input.status,
      attempts,
      value: input.value ?? previous?.value ?? null,
      error: sanitizeCacheError(input.error ?? null),
      retryAt,
      updatedAt: this.timestamp(),
    };
  }

  markProcessing(bucket: ExporterCacheBucket, key: string) {
    const previous = this.document[bucket][key];
    this.set(bucket, key, {
      status: "processing",
      attempts: (previous?.attempts ?? 0) + 1,
      value: previous?.value ?? null,
    });
  }

  markCompleted<T>(bucket: ExporterCacheBucket, key: string, value: T) {
    this.set(bucket, key, {
      status: "completed",
      value,
      error: null,
      retryAt: null,
    });
  }

  markRetry<T>(
    bucket: ExporterCacheBucket,
    key: string,
    value: T | null,
    retryAt: string,
    error: string,
  ) {
    this.set(bucket, key, {
      status: "retry_wait",
      value,
      retryAt,
      error,
    });
  }

  markFailed<T>(
    bucket: ExporterCacheBucket,
    key: string,
    value: T | null,
    error: string,
  ) {
    this.set(bucket, key, {
      status: "failed",
      value,
      error,
      retryAt: null,
    });
  }

  listUnfinished<T = unknown>(bucket: ExporterCacheBucket) {
    return Object.entries(this.document[bucket])
      .filter(([, item]) =>
        ["pending", "processing", "retry_wait"].includes(item.status),
      )
      .map(([key, item]) => ({
        key,
        item: cloneJson(item) as ExporterCacheItem<T>,
      }));
  }

  setCoverageWarnings(warnings: readonly string[]) {
    const normalized = [...new Set(warnings.map((warning) => warning.trim()))]
      .filter(Boolean)
      .map((warning) => sanitizeCacheError(warning) ?? "")
      .filter(Boolean);
    this.document.coverageWarnings = normalized;
    this.document.updatedAt = this.timestamp();
  }

  async save() {
    const operation = this.writeChain.then(async () => {
      this.document.updatedAt = this.timestamp();
      assertSafeCacheValue(this.document, "cache");
      await atomicWriteJson(
        resolve(this.directory, EXPORTER_CACHE_FILE),
        this.document,
      );
    });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  recoverInterruptedWork() {
    let changed = false;
    const now = this.now();
    for (const bucket of ["sources", "companies"] as const) {
      for (const item of Object.values(this.document[bucket])) {
        const retryElapsed =
          item.status === "retry_wait" &&
          (!item.retryAt || Date.parse(item.retryAt) <= now);
        if (item.status === "processing" || retryElapsed) {
          item.status = "pending";
          item.retryAt = null;
          item.updatedAt = new Date(now).toISOString();
          changed = true;
        }
      }
    }
    return changed;
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }
}

async function ensureCacheDirectory(directory: string) {
  assertSafeCacheDirectory(directory);
  const existing = await safeLstat(directory);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new ExporterCacheError("The exporter cache path must be a real directory.");
  }
  await mkdir(directory, { recursive: true });
  const markerPath = resolve(directory, CACHE_MARKER_FILE);
  const marker = await readOptionalText(markerPath);
  if (marker === null) {
    await writeFile(markerPath, CACHE_MARKER, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } else if (marker !== CACHE_MARKER) {
    throw new ExporterCacheError("The exporter cache marker is invalid.");
  }
}

async function assertCacheMarker(directory: string) {
  const marker = await readOptionalText(resolve(directory, CACHE_MARKER_FILE));
  if (marker !== CACHE_MARKER) {
    throw new ExporterCacheError(
      "Refusing to reset an unmarked directory. Remove it manually if it is safe.",
    );
  }
}

function assertSafeCacheDirectory(directory: string) {
  const root = parse(directory).root;
  if (directory === root || directory === resolve(process.cwd())) {
    throw new ExporterCacheError("Refusing to use an unsafe cache directory.");
  }
}

async function readCacheDocument(filePath: string) {
  const raw = await readOptionalText(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ExporterCacheDocument;
  } catch {
    return null;
  }
}

function migrateLegacySourceEntries(value: ExporterCacheDocument) {
  if (!value || typeof value !== "object" || !isPlainObject(value.sources)) {
    return false;
  }
  let changed = false;
  for (const [key, rawItem] of Object.entries(value.sources)) {
    if (!isPlainObject(rawItem)) {
      delete value.sources[key];
      changed = true;
      continue;
    }
    const item = rawItem as Partial<ExporterCacheItem>;
    if (item.value === null || item.value === undefined) continue;
    const serialized = serializeSourceWorkResultForCache(item.value);
    if (!serialized) {
      delete value.sources[key];
      changed = true;
      continue;
    }
    try {
      assertSafeSerializedSourceCacheValue(item.value);
    } catch {
      item.value = serialized;
      changed = true;
    }
  }
  return changed;
}

function validateCacheDocument(value: ExporterCacheDocument) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== EXPORTER_CACHE_VERSION ||
    typeof value.optionsFingerprint !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isPlainObject(value.sources) ||
    !isPlainObject(value.companies) ||
    !Array.isArray(value.coverageWarnings)
  ) {
    throw new ExporterCacheError(
      "The exporter cache version or structure is unsupported. Use --fresh to start again.",
    );
  }
  assertFingerprint(value.optionsFingerprint);
  for (const bucket of [value.sources, value.companies]) {
    for (const [key, item] of Object.entries(bucket)) {
      assertCacheKey(key);
      validateCacheItem(item);
    }
  }
  assertSafeCacheValue(value, "cache");
}

function validateCacheItem(value: unknown): asserts value is ExporterCacheItem {
  if (!isPlainObject(value)) {
    throw new ExporterCacheError("The exporter cache contains an invalid work item.");
  }
  const item = value as Partial<ExporterCacheItem>;
  if (
    !["pending", "processing", "completed", "retry_wait", "failed"].includes(
      item.status ?? "",
    ) ||
    !Number.isSafeInteger(item.attempts) ||
    (item.attempts ?? -1) < 0 ||
    typeof item.updatedAt !== "string" ||
    (item.error !== null && typeof item.error !== "string") ||
    (item.retryAt !== null && typeof item.retryAt !== "string")
  ) {
    throw new ExporterCacheError("The exporter cache contains an invalid work item.");
  }
  if (item.retryAt) normalizeRetryAt(item.retryAt);
}

async function atomicWriteJson(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceCacheFileWithRetry(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceCacheFileWithRetry(
  sourcePath: string,
  destinationPath: string,
  renameFile: (source: string, destination: string) => Promise<void> = rename,
  wait: (milliseconds: number) => Promise<unknown> = delay,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : null;
      const retryDelay = CACHE_REPLACE_RETRY_DELAYS_MS[attempt];
      if (!code || !RETRYABLE_CACHE_REPLACE_CODES.has(code) || retryDelay === undefined) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}

function stableStringify(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ExporterCacheError("Cache options must contain finite numbers.");
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  throw new ExporterCacheError("Cache values must be JSON-serializable.");
}

function assertSafeCacheValue(value: unknown, path: string, seen = new Set<object>()) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ExporterCacheError(`Non-finite number at ${path}.`);
    }
    return;
  }
  if (typeof value === "string") {
    if (/<!doctype\s+html|<html(?:\s|>)/i.test(value)) {
      throw new ExporterCacheError("Raw HTML cannot be stored in the exporter cache.");
    }
    return;
  }
  if (value instanceof Date) return;
  if (typeof value !== "object") {
    throw new ExporterCacheError(`Non-JSON value at ${path}.`);
  }
  if (seen.has(value)) {
    throw new ExporterCacheError("Circular values cannot be stored in the exporter cache.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeCacheValue(entry, `${path}[${index}]`, seen),
    );
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (PROHIBITED_CACHE_FIELD_NAMES.has(normalizedKey)) {
        throw new ExporterCacheError(
          `Sensitive or raw content field cannot be cached: ${path}.${key}.`,
        );
      }
      assertSafeCacheValue(entry, `${path}.${key}`, seen);
    }
  } else {
    throw new ExporterCacheError(`Non-JSON object at ${path}.`);
  }
  seen.delete(value);
}

const PROHIBITED_CACHE_FIELD_NAMES = new Set([
  "html",
  "rawhtml",
  "responsebody",
  "rawbody",
  "body",
  "rawpayload",
  "pagecontent",
  "pagetext",
  "dom",
  "domserialization",
  "headers",
  "requestheaders",
  "responseheaders",
  "password",
  "secret",
  "apikey",
  "searchapikey",
  "bravesearchapikey",
  "servicerolekey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "session",
  "sessiontoken",
  "cookie",
  "cookies",
  "reoonapikey",
  "braveresponse",
  "bravepayload",
  "robotstxt",
  "robotsbody",
]);

function sanitizeCacheError(value: string | null) {
  if (!value) return null;
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .trim()
    .slice(0, 500);
}

function normalizeRetryAt(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ExporterCacheError("Cache retryAt values must be valid timestamps.");
  }
  return new Date(parsed).toISOString();
}

function assertFingerprint(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ExporterCacheError("The exporter options fingerprint is invalid.");
  }
}

function assertCacheKey(value: string) {
  if (!value || value.length > 2_000 || /[\u0000-\u001f]/.test(value)) {
    throw new ExporterCacheError("The exporter cache key is invalid.");
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
