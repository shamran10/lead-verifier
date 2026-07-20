import { isIP } from "node:net";

import {
  DISCOVERY_SOURCE_KINDS,
  DiscoveryError,
  type DiscoverySourceKind,
} from "@/lib/500-global/types";

const DEFAULT_APPROVED_HOST = "500.co";
const UNSAFE_HOST_SUFFIXES = [
  ".example",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".test",
] as const;

export type NormalizedDiscoverySource = {
  url: string;
  normalizedUrl: string;
  hostname: string;
  approvedByDefault: boolean;
};

export function parseDiscoverySourceKind(value: unknown) {
  return typeof value === "string" &&
    DISCOVERY_SOURCE_KINDS.includes(value as DiscoverySourceKind)
    ? (value as DiscoverySourceKind)
    : null;
}

export function normalizeDiscoverySourceUrl(
  value: string,
): NormalizedDiscoverySource {
  const trimmed = value.trim();
  if (!trimmed) throw new DiscoveryError("Enter a source URL.", 400);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DiscoveryError("Enter a valid HTTPS source URL.", 400);
  }

  if (url.protocol !== "https:") {
    throw new DiscoveryError("Source URLs must use HTTPS.", 400);
  }
  if (url.username || url.password) {
    throw new DiscoveryError("Source URLs cannot contain credentials.", 400);
  }
  if (url.port && url.port !== "443") {
    throw new DiscoveryError("Source URLs cannot use a custom port.", 400);
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (isObviouslyUnsafeHostname(hostname)) {
    throw new DiscoveryError("That source host is not allowed.", 400);
  }

  url.hostname = hostname;
  url.hash = "";
  url.username = "";
  url.password = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/g, "");

  const normalizedUrl = url.toString();
  return {
    url: normalizedUrl,
    normalizedUrl,
    hostname,
    approvedByDefault:
      hostname === DEFAULT_APPROVED_HOST ||
      hostname.endsWith(`.${DEFAULT_APPROVED_HOST}`),
  };
}

function isObviouslyUnsafeHostname(hostname: string) {
  if (
    !hostname ||
    hostname === "localhost" ||
    !hostname.includes(".") ||
    UNSAFE_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isUnsafeIpv4(hostname);
  if (ipVersion === 6) return isUnsafeIpv6(hostname);
  return false;
}

export function assertPublicDiscoveryAddress(address: string) {
  const version = isIP(address);
  if (
    !version ||
    (version === 4 && isUnsafeIpv4(address)) ||
    (version === 6 && isUnsafeIpv6(address))
  ) {
    throw new DiscoveryError("The source host resolved to a blocked network address.", 400);
  }
}

function isUnsafeIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isUnsafeIpv6(hostname: string) {
  const value = hostname.toLowerCase();
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:") ||
    value.startsWith("::ffff:")
  );
}
