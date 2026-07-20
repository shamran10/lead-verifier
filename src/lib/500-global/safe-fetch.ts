import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";

import robotsParser from "robots-parser";

import {
  assertPublicDiscoveryAddress,
  normalizeDiscoverySourceUrl,
} from "@/lib/500-global/source-policy-core";

const USER_AGENT = "FounderEmailVerifier/1.0 official-source-discovery";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export type SafeFetchTransportOptions = {
  beforeRequest?: (url: URL) => Promise<void>;
  userAgent?: string;
  robotsCache?: Map<
    string,
    { robotsUrl: string; robotsText: string | null; checkedAt: string }
  >;
  onRetryAfter?: (url: URL, retryAt: string) => void;
  signal?: AbortSignal;
};

type RawResponse = {
  url: URL;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  redirectCount: number;
};

export type SafeHtmlResponse = {
  finalUrl: string;
  html: string;
  status: number;
  contentType: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
  robotsCheckedAt: string;
  redirectCount: number;
};

type FetchDiagnosticContext = {
  runId?: string;
  sourceId?: string;
};

export class DiscoveryFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: "blocked" | "retry" | "invalid" | "error",
    public readonly retryAt: string | null = null,
    public readonly status: number | null = null,
    public readonly diagnosticName: string = "DiscoveryFetchError",
    public readonly diagnosticCode: string | null = null,
    public readonly robotsAllowed: boolean | null = null,
    public readonly robotsCheckedAt: string | null = null,
  ) {
    super(message);
  }
}

export async function fetchOfficialDiscoveryHtml(
  inputUrl: string,
  context: FetchDiagnosticContext = {},
  transport: SafeFetchTransportOptions = {},
): Promise<SafeHtmlResponse> {
  return fetchDiscoveryHtml(inputUrl, context, null, transport);
}

export async function fetchCompanyEnrichmentHtml(
  inputUrl: string,
  companyUrl: string,
  context: FetchDiagnosticContext = {},
  transport: SafeFetchTransportOptions = {},
): Promise<SafeHtmlResponse> {
  const company = normalizeDiscoverySourceUrl(companyUrl);
  const allowedHost = companyHostKey(new URL(company.normalizedUrl));
  return fetchDiscoveryHtml(inputUrl, context, allowedHost, transport);
}

async function fetchDiscoveryHtml(
  inputUrl: string,
  context: FetchDiagnosticContext,
  allowedHost: string | null,
  transport: SafeFetchTransportOptions,
): Promise<SafeHtmlResponse> {
  const source = normalizeDiscoverySourceUrl(inputUrl);
  const targetUrl = new URL(source.normalizedUrl);
  assertAllowedCompanyHost(targetUrl, allowedHost);
  const robotsCheckedAt = new Date().toISOString();
  try {
    await assertRobotsAllowed(targetUrl, robotsCheckedAt, allowedHost, transport);
  } catch (error) {
    logFetchFailure("robots_fetch", error, context);
    throw error;
  }

  let response: RawResponse;
  try {
    response = await requestFollowingRedirects(
      targetUrl,
      MAX_HTML_BYTES,
      allowedHost,
      transport,
      true,
    );
  } catch (error) {
    logFetchFailure("source_fetch", error, context);
    throw error;
  }
  if (response.status === 429) {
    const error = retryError(response);
    if (error.retryAt) transport.onRetryAfter?.(response.url, error.retryAt);
    logFetchFailure("source_fetch", error, context);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new DiscoveryFetchError(
      `The source returned HTTP ${response.status}.`,
      response.status >= 500 ? "error" : "invalid",
      null,
      response.status,
    );
    logFetchFailure("source_fetch", error, context);
    throw error;
  }

  const contentType = firstHeader(response.headers["content-type"])
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    const error = new DiscoveryFetchError(
      "The source did not return HTML.",
      "invalid",
      null,
      response.status,
    );
    logFetchFailure("source_fetch", error, context);
    throw error;
  }

  return {
    finalUrl: response.url.toString(),
    html: new TextDecoder().decode(response.body),
    status: response.status,
    contentType,
    contentHash: createHash("sha256").update(response.body).digest("hex"),
    etag: nullableHeader(response.headers.etag),
    lastModified: nullableHeader(response.headers["last-modified"]),
    fetchedAt: new Date().toISOString(),
    robotsCheckedAt,
    redirectCount: response.redirectCount,
  };
}

async function assertRobotsAllowed(
  targetUrl: URL,
  robotsCheckedAt: string,
  allowedHost: string | null,
  transport: SafeFetchTransportOptions,
) {
  const cached = transport.robotsCache?.get(targetUrl.origin);
  if (cached) {
    assertPathAllowedByRobots(targetUrl, cached, transport.userAgent ?? USER_AGENT);
    return;
  }
  const robotsUrl = new URL("/robots.txt", targetUrl.origin);
  const response = await requestFollowingRedirects(
    robotsUrl,
    MAX_ROBOTS_BYTES,
    allowedHost,
    transport,
  );
  if (response.status === 404 || response.status === 410) {
    transport.robotsCache?.set(targetUrl.origin, {
      robotsUrl: robotsUrl.toString(),
      robotsText: null,
      checkedAt: robotsCheckedAt,
    });
    return;
  }
  if (response.status === 429) {
    const error = retryError(response);
    if (error.retryAt) transport.onRetryAfter?.(response.url, error.retryAt);
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    transport.robotsCache?.set(targetUrl.origin, {
      robotsUrl: robotsUrl.toString(),
      robotsText: "User-agent: *\nDisallow: /",
      checkedAt: robotsCheckedAt,
    });
    throw new DiscoveryFetchError(
      "The source blocks automated access.",
      "blocked",
      null,
      response.status,
      "DiscoveryFetchError",
      null,
      false,
      robotsCheckedAt,
    );
  }
  if (response.status >= 500) {
    throw new DiscoveryFetchError(
      `The source robots policy returned HTTP ${response.status}.`,
      "error",
      null,
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    transport.robotsCache?.set(targetUrl.origin, {
      robotsUrl: robotsUrl.toString(),
      robotsText: null,
      checkedAt: robotsCheckedAt,
    });
    return;
  }

  const entry = {
    robotsUrl: response.url.toString(),
    robotsText: new TextDecoder().decode(response.body),
    checkedAt: robotsCheckedAt,
  };
  transport.robotsCache?.set(targetUrl.origin, entry);
  assertPathAllowedByRobots(targetUrl, entry, transport.userAgent ?? USER_AGENT);
}

async function requestFollowingRedirects(
  initialUrl: URL,
  maxBytes: number,
  allowedHost: string | null = null,
  transport: SafeFetchTransportOptions = {},
  revalidateRedirectRobots = false,
) {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedCompanyHost(currentUrl, allowedHost);
    if (revalidateRedirectRobots && redirects > 0) {
      await assertRobotsAllowed(
        currentUrl,
        new Date().toISOString(),
        allowedHost,
        transport,
      );
    }
    await transport.beforeRequest?.(currentUrl);
    const response = await requestOnce(
      currentUrl,
      maxBytes,
      transport.userAgent ?? USER_AGENT,
      transport.signal,
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { ...response, redirectCount: redirects };
    }
    if (redirects === MAX_REDIRECTS) {
      throw new DiscoveryFetchError("The source exceeded the redirect limit.", "invalid");
    }
    const location = firstHeader(response.headers.location);
    if (!location) {
      throw new DiscoveryFetchError("The source returned an invalid redirect.", "invalid");
    }
    currentUrl = normalizeRedirectTarget(location, currentUrl);
    assertAllowedCompanyHost(currentUrl, allowedHost);
  }
  throw new DiscoveryFetchError("The source exceeded the redirect limit.", "invalid");
}

export function normalizeRedirectTarget(location: string, currentUrl: URL) {
  const resolved = new URL(location, currentUrl);
  const redirected = normalizeDiscoverySourceUrl(resolved.toString());
  const target = new URL(redirected.normalizedUrl);
  // Discovery URL identity intentionally removes trailing slashes, but an
  // origin may require one and redirect the slashless path back to it. Keep
  // that server-provided slash for the actual request to avoid a redirect
  // normalization loop while retaining every other URL safety check.
  if (
    resolved.pathname !== "/" &&
    resolved.pathname.endsWith("/") &&
    !target.pathname.endsWith("/")
  ) {
    target.pathname += "/";
  }
  return target;
}

function assertPathAllowedByRobots(
  targetUrl: URL,
  entry: { robotsUrl: string; robotsText: string | null; checkedAt: string },
  userAgent: string,
) {
  if (
    !isRobotsPathAllowed(
      targetUrl,
      entry.robotsUrl,
      entry.robotsText,
      userAgent,
    )
  ) {
    throw new DiscoveryFetchError(
      "The source robots policy disallows this page.",
      "blocked",
      null,
      null,
      "DiscoveryFetchError",
      null,
      false,
      entry.checkedAt,
    );
  }
}

export function isRobotsPathAllowed(
  targetUrl: string | URL,
  robotsUrl: string,
  robotsText: string | null,
  userAgent = USER_AGENT,
) {
  if (robotsText === null) return true;
  const target = targetUrl instanceof URL ? targetUrl.toString() : targetUrl;
  return robotsParser(robotsUrl, robotsText).isAllowed(target, userAgent) !== false;
}

function companyHostKey(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function assertAllowedCompanyHost(url: URL, allowedHost: string | null) {
  if (allowedHost && companyHostKey(url) !== allowedHost) {
    throw new DiscoveryFetchError(
      "The company page redirected outside its approved host.",
      "blocked",
    );
  }
}

async function requestOnce(
  url: URL,
  maxBytes: number,
  userAgent: string,
  signal?: AbortSignal,
): Promise<RawResponse> {
  if (signal?.aborted) {
    throw new DiscoveryFetchError("The source request was cancelled.", "error");
  }
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new DiscoveryFetchError("The source host could not be resolved.", "error");
  }
  if (signal?.aborted) {
    throw new DiscoveryFetchError("The source request was cancelled.", "error");
  }
  if (!addresses.length) {
    throw new DiscoveryFetchError("The source host could not be resolved.", "error");
  }
  const pinnedLookup = createPinnedLookup(addresses);

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup,
        servername: url.hostname,
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
          "Accept-Encoding": "identity",
          "User-Agent": userAgent,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error("response-too-large"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            url,
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            redirectCount: 0,
          });
        });
      },
    );
    const abortRequest = () => req.destroy(new Error("request-aborted"));
    signal?.addEventListener("abort", abortRequest, { once: true });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("request-timeout")));
    req.on("error", (error) => {
      signal?.removeEventListener("abort", abortRequest);
      const message =
        error.message === "response-too-large"
          ? "The source response exceeded the size limit."
          : error.message === "request-timeout"
            ? "The source request timed out."
            : error.message === "request-aborted"
              ? "The source request was cancelled."
            : "The source request failed.";
      reject(
        new DiscoveryFetchError(
          message,
          error.message === "response-too-large" ? "invalid" : "error",
          null,
          null,
          error.name,
          typeof (error as NodeJS.ErrnoException).code === "string"
            ? (error as NodeJS.ErrnoException).code ?? null
            : null,
        ),
      );
    });
    req.on("close", () => signal?.removeEventListener("abort", abortRequest));
    req.end();
  });
}

type PinnedAddress = { address: string; family: number };
type LookupOptionsLike = number | { all?: boolean };
type LookupOneCallback = (
  error: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;
type LookupAllCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: PinnedAddress[],
) => void;

export function createPinnedLookup(addresses: readonly PinnedAddress[]): LookupFunction {
  if (!addresses.length) {
    throw new DiscoveryFetchError("The source host could not be resolved.", "error");
  }
  for (const address of addresses) assertPublicDiscoveryAddress(address.address);
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  const selected = pinned[0];
  return ((
    _hostname: string,
    options: LookupOptionsLike,
    callback: LookupOneCallback | LookupAllCallback,
  ) => {
    if (typeof options === "object" && options?.all === true) {
      (callback as LookupAllCallback)(null, pinned.map((address) => ({ ...address })));
      return;
    }
    (callback as LookupOneCallback)(null, selected.address, selected.family);
  }) as LookupFunction;
}

function retryError(response: RawResponse) {
  const retryAt = parseRetryAfter(response.headers["retry-after"]);
  return new DiscoveryFetchError(
    "The source rate-limited the request. It will be retried later.",
    "retry",
    retryAt,
    response.status,
  );
}

function parseRetryAfter(value: string | string[] | undefined) {
  const raw = firstHeader(value);
  const now = Date.now();
  const seconds = Number(raw);
  const requested = Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000
    : Date.parse(raw);
  const fallback = now + 15 * 60 * 1000;
  const bounded = Number.isFinite(requested)
    ? Math.min(Math.max(requested, now + 30_000), now + 24 * 60 * 60 * 1000)
    : fallback;
  return new Date(bounded).toISOString();
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function nullableHeader(value: string | string[] | undefined) {
  const header = firstHeader(value).trim();
  return header ? header.slice(0, 500) : null;
}

function logFetchFailure(
  operation: "robots_fetch" | "source_fetch",
  error: unknown,
  context: FetchDiagnosticContext,
) {
  const fetchError = error instanceof DiscoveryFetchError ? error : null;
  const diagnostic = error instanceof Error ? error : null;
  console.error("[lead discovery] Safe fetch failed", {
    operation,
    name: sanitizeDiagnostic(fetchError?.diagnosticName ?? diagnostic?.name ?? "Error"),
    code: sanitizeDiagnostic(fetchError?.diagnosticCode),
    message: sanitizeDiagnostic(fetchError?.message ?? diagnostic?.message ?? "Request failed."),
    run_id: sanitizeIdentifier(context.runId),
    source_id: sanitizeIdentifier(context.sourceId),
  });
}

function sanitizeDiagnostic(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(bearer\s+|password[=:]\s*|secret[=:]\s*|token[=:]\s*|key[=:]\s*)\S+/gi, "$1[redacted]")
    .trim()
    .slice(0, 240);
}

function sanitizeIdentifier(value: string | undefined) {
  return value && /^[a-z0-9-]{1,80}$/i.test(value) ? value : null;
}
