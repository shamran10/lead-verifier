import "server-only";

import type { AttemptVerificationStatus } from "@/lib/database.types";

const REOON_VERIFY_URL = "https://emailverifier.reoon.com/api/v1/verify";
const PROVIDER_TIMEOUT_MS = 85_000;

type JsonObject = Record<string, unknown>;

export type NormalizedReoonResult = {
  accepted: boolean;
  isError: boolean;
  verificationStatus: AttemptVerificationStatus;
  isSafeToSend: boolean | null;
  isCatchAll: boolean | null;
  isRoleBased: boolean | null;
  isDisposable: boolean | null;
  rawResult: JsonObject;
  errorMessage: string | null;
};

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function normalizedStatus(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function firstBoolean(...values: unknown[]) {
  for (const value of values) {
    const normalized = booleanOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

export function normalizeReoonResult(rawResult: JsonObject): NormalizedReoonResult {
  const email = typeof rawResult.email === "string" ? rawResult.email.trim() : "";
  const status = normalizedStatus(rawResult.status);
  const mode = normalizedStatus(rawResult.verification_mode ?? rawResult.mode);
  const isSafeToSend = booleanOrNull(rawResult.is_safe_to_send);
  const isCatchAll = booleanOrNull(rawResult.is_catch_all);
  const isRoleBased = firstBoolean(
    rawResult.is_role_based,
    rawResult.is_role_account,
    rawResult.role_account,
  );
  const isDisposable = booleanOrNull(rawResult.is_disposable);
  const isSpamtrap = booleanOrNull(rawResult.is_spamtrap);
  const isDisabled = booleanOrNull(rawResult.is_disabled);
  const hasInboxFull = firstBoolean(
    rawResult.has_inbox_full,
    rawResult.is_inbox_full,
  );
  const isDeliverable = booleanOrNull(rawResult.is_deliverable);
  const isValidSyntax = booleanOrNull(rawResult.is_valid_syntax);
  const mxAcceptsMail = booleanOrNull(rawResult.mx_accepts_mail);
  const canConnectSmtp = booleanOrNull(rawResult.can_connect_smtp);

  if (!email || !status || mode !== "power" || isSafeToSend === null) {
    return {
      accepted: false,
      isError: true,
      verificationStatus: "malformed",
      isSafeToSend,
      isCatchAll,
      isRoleBased,
      isDisposable,
      rawResult,
      errorMessage: "Reoon returned an incomplete or malformed Power-mode result.",
    };
  }

  const blockingStatus =
    (isCatchAll && "catch_all") ||
    (isRoleBased && "role_based") ||
    (isDisposable && "disposable") ||
    (isSpamtrap && "spamtrap") ||
    (isDisabled && "disabled") ||
    (hasInboxFull && "inbox_full") ||
    (isDeliverable === false && "unsafe") ||
    (isValidSyntax === false && "invalid") ||
    (mxAcceptsMail === false && "invalid") ||
    (canConnectSmtp === false && "unsafe");

  if (
    status === "safe" &&
    isSafeToSend === true &&
    !blockingStatus
  ) {
    return {
      accepted: true,
      isError: false,
      verificationStatus: "valid",
      isSafeToSend,
      isCatchAll,
      isRoleBased,
      isDisposable,
      rawResult,
      errorMessage: null,
    };
  }

  const statusMap: Record<string, AttemptVerificationStatus> = {
    catch_all: "catch_all",
    catchall: "catch_all",
    unknown: "unknown",
    role: "role_based",
    role_account: "role_based",
    role_based: "role_based",
    disposable: "disposable",
    temporary: "disposable",
    risky: "risky",
    risk: "risky",
    spamtrap: "spamtrap",
    spam_trap: "spamtrap",
    valid: "unsafe",
    invalid: "invalid",
    disabled: "disabled",
    inbox_full: "inbox_full",
    unsafe: "unsafe",
  };

  let verificationStatus =
    statusMap[status] ?? (status === "safe" ? "unsafe" : "malformed");
  if (blockingStatus) verificationStatus = blockingStatus;

  // Reoon marks unknown results as not safe to send. Preserve that invariant even
  // if an inconsistent payload ever contains a different boolean value.
  const normalizedSafeToSend =
    verificationStatus === "unknown" ? false : isSafeToSend;

  return {
    accepted: false,
    isError: verificationStatus === "malformed",
    verificationStatus,
    isSafeToSend: normalizedSafeToSend,
    isCatchAll,
    isRoleBased,
    isDisposable,
    rawResult,
    errorMessage:
      verificationStatus === "malformed"
        ? "Reoon returned an unrecognized verification status."
        : null,
  };
}

export async function verifyEmailWithReoon(
  candidateEmail: string,
): Promise<NormalizedReoonResult> {
  const apiKey = process.env.REOON_API_KEY;
  if (!apiKey) {
    throw new Error("Reoon verification is not configured.");
  }

  const url = new URL(REOON_VERIFY_URL);
  url.searchParams.set("email", candidateEmail);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("mode", "power");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new Error(
      isTimeout
        ? "Reoon verification timed out."
        : "Could not reach Reoon verification.",
    );
  }

  if (!response.ok) {
    throw new Error(`Reoon verification failed with HTTP ${response.status}.`);
  }

  let rawResult: unknown;
  try {
    rawResult = await response.json();
  } catch {
    throw new Error("Reoon returned a non-JSON response.");
  }

  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
    throw new Error("Reoon returned a malformed response.");
  }

  return normalizeReoonResult(rawResult as JsonObject);
}
