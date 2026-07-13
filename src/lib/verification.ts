import "server-only";

import type {
  AttemptVerificationStatus,
  BatchStatus,
} from "@/lib/database.types";
import { normalizeReoonResult, verifyEmailWithReoon } from "@/lib/reoon";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type {
  VerificationProgress,
  VerificationStepResult,
} from "@/lib/types";

const TERMINAL_FOUNDER_STATUSES = new Set([
  "valid",
  "no_valid_email",
  "verification_error",
]);
const ERROR_ATTEMPT_STATUSES = new Set([
  "error",
  "provider_error",
  "timeout",
  "malformed",
  "malformed_response",
]);
const PROCESSING_STALE_AFTER_MS = 3 * 60 * 1000;

type CandidateType = "first_name" | "last_name";

type FounderForVerification = {
  id: string;
  first_candidate_email: string;
  last_candidate_email: string | null;
  status: string;
};

type AttemptForVerification = {
  id: string;
  candidate_type: string;
  candidate_email: string;
  verification_status: AttemptVerificationStatus | null;
  is_safe_to_send: boolean | null;
  attempted_at: string;
  error_message: string | null;
  raw_result: Record<string, unknown> | null;
};

export class VerificationStateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function isTerminalFounderStatus(status: string) {
  return TERMINAL_FOUNDER_STATUSES.has(status);
}

function isAcceptedAttempt(attempt: AttemptForVerification) {
  return (
    attempt.verification_status === "valid" &&
    attempt.is_safe_to_send === true
  );
}

function isErrorAttempt(attempt: AttemptForVerification) {
  return Boolean(
    attempt.verification_status &&
      ERROR_ATTEMPT_STATUSES.has(attempt.verification_status),
  );
}

function isRetryableAttempt(attempt: AttemptForVerification) {
  return (
    Boolean(
      attempt.verification_status &&
        ERROR_ATTEMPT_STATUSES.has(attempt.verification_status),
    ) ||
    /\b(incomplete|malformed)\b.*\b(power.?mode|response|result)\b/i.test(
      attempt.error_message ?? "",
    )
  );
}

function isFreshProcessingAttempt(attempt: AttemptForVerification) {
  return (
    attempt.verification_status === "processing" &&
    Date.now() - new Date(attempt.attempted_at).getTime() <
      PROCESSING_STALE_AFTER_MS
  );
}

function sameEmail(left: string | null, right: string | null) {
  return Boolean(
    left && right && left.trim().toLowerCase() === right.trim().toLowerCase(),
  );
}

function candidatePattern(candidateType: string) {
  return candidateType === "last_name" ? "last_name" : "first_name";
}

function sanitizedProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : "Reoon verification failed.";
  const allowedMessages = new Set([
    "Reoon verification is not configured.",
    "Reoon verification timed out.",
    "Could not reach Reoon verification.",
    "Reoon returned a non-JSON response.",
    "Reoon returned a malformed response.",
    "Reoon returned an incomplete or malformed Power-mode result.",
    "Reoon returned an unrecognized verification status.",
  ]);

  if (allowedMessages.has(message) || /^Reoon verification failed with HTTP \d{3}\.$/.test(message)) {
    return message;
  }

  return "Reoon verification failed.";
}

async function getBatch(batchId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("fev_batches")
    .select("id, status")
    .eq("id", batchId)
    .maybeSingle();

  if (error) throw new Error("Could not load the verification batch.");
  if (!data) throw new VerificationStateError("Batch not found.", 404);
  return data;
}

async function updateFounderValid(
  batchId: string,
  founderId: string,
  candidateEmail: string,
  candidateType: string,
) {
  const { error } = await getSupabaseAdmin()
    .from("fev_founders")
    .update({
      selected_email: candidateEmail,
      selected_pattern: candidatePattern(candidateType),
      status: "valid",
      verification_status: "valid",
      is_safe_to_send: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", founderId)
    .eq("batch_id", batchId)
    .eq("status", "pending");

  if (error) throw new Error("Could not save the valid founder result.");
}

async function updateFounderTerminal(
  batchId: string,
  founderId: string,
  status: "no_valid_email" | "verification_error",
) {
  const { error } = await getSupabaseAdmin()
    .from("fev_founders")
    .update({
      selected_email: null,
      selected_pattern: null,
      status,
      verification_status: status === "verification_error" ? "error" : "no_valid_email",
      is_safe_to_send: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", founderId)
    .eq("batch_id", batchId)
    .eq("status", "pending");

  if (error) throw new Error("Could not save the founder verification result.");
}

async function loadAttemptsForFounder(founderId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("fev_verification_attempts")
    .select(
      "id, candidate_type, candidate_email, verification_status, is_safe_to_send, attempted_at, error_message, raw_result",
    )
    .eq("founder_id", founderId)
    .order("attempted_at", { ascending: true });

  if (error) throw new Error("Could not load verification attempts.");
  return (data ?? []) as AttemptForVerification[];
}

async function expireStaleAttempt(
  batchId: string,
  founderId: string,
  attempt: AttemptForVerification,
) {
  const message =
    "The reserved Reoon request did not finish and will not be retried.";
  const { data, error } = await getSupabaseAdmin()
    .from("fev_verification_attempts")
    .update({
      verification_status: "error",
      is_safe_to_send: null,
      is_catch_all: null,
      is_role_based: null,
      is_disposable: null,
      error_message: message,
    })
    .eq("id", attempt.id)
    .eq("verification_status", "processing")
    .select("id")
    .maybeSingle();

  if (error) throw new Error("Could not close a stale verification attempt.");
  if (data) {
    await updateFounderTerminal(batchId, founderId, "verification_error");
  }
}

export async function getVerificationProgress(
  batchId: string,
): Promise<VerificationProgress> {
  const supabase = getSupabaseAdmin();
  const [batchResult, foundersResult] = await Promise.all([
    supabase
      .from("fev_batches")
      .select("id, status, total_founders, valid_emails, no_valid_emails")
      .eq("id", batchId)
      .maybeSingle(),
    supabase.from("fev_founders").select("id, status").eq("batch_id", batchId),
  ]);

  if (batchResult.error || foundersResult.error) {
    throw new Error("Could not load verification progress.");
  }
  if (!batchResult.data) {
    throw new VerificationStateError("Batch not found.", 404);
  }

  const founders = foundersResult.data ?? [];
  const founderIds = founders.map((founder) => founder.id);
  let attempts: Array<{
    founder_id: string;
    candidate_email: string;
    verification_status: AttemptVerificationStatus | null;
    error_message: string | null;
    attempted_at: string;
  }> = [];

  if (founderIds.length > 0) {
    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .select(
        "founder_id, candidate_email, verification_status, error_message, attempted_at",
      )
      .in("founder_id", founderIds)
      .order("attempted_at", { ascending: false });

    if (error) throw new Error("Could not load verification attempts.");
    attempts = data ?? [];
  }

  const validEmails = founders.filter((founder) => founder.status === "valid").length;
  const noValidEmails = founders.filter(
    (founder) => founder.status === "no_valid_email",
  ).length;
  const errorFounders = founders.filter(
    (founder) => founder.status === "verification_error",
  ).length;
  const processedFounders = founders.filter((founder) =>
    isTerminalFounderStatus(founder.status),
  ).length;
  const totalFounders = founders.length;
  const errorAttempts = attempts.filter(
    (attempt) =>
      attempt.verification_status &&
      ERROR_ATTEMPT_STATUSES.has(attempt.verification_status),
  );

  return {
    batchId,
    status: batchResult.data.status,
    totalFounders,
    processedFounders,
    remainingFounders: Math.max(totalFounders - processedFounders, 0),
    validEmails,
    noValidEmails,
    errorFounders,
    attemptCount: attempts.length,
    errorAttemptCount: errorAttempts.length,
    percentComplete:
      totalFounders === 0
        ? 100
        : Math.round((processedFounders / totalFounders) * 100),
    errors: errorAttempts.slice(0, 20).map((attempt) => ({
      founderId: attempt.founder_id,
      candidateEmail: attempt.candidate_email,
      message: attempt.error_message ?? "Verification result was malformed.",
      attemptedAt: attempt.attempted_at,
    })),
  };
}

async function recomputeBatch(batchId: string) {
  const supabase = getSupabaseAdmin();
  const [batch, foundersResult] = await Promise.all([
    getBatch(batchId),
    supabase.from("fev_founders").select("status").eq("batch_id", batchId),
  ]);

  if (foundersResult.error) {
    throw new Error("Could not recompute batch verification totals.");
  }

  const founders = foundersResult.data ?? [];
  const validEmails = founders.filter((founder) => founder.status === "valid").length;
  const noValidEmails = founders.filter(
    (founder) => founder.status === "no_valid_email",
  ).length;
  const hasErrors = founders.some(
    (founder) => founder.status === "verification_error",
  );
  const allTerminal = founders.every((founder) =>
    isTerminalFounderStatus(founder.status),
  );
  const nextStatus: BatchStatus =
    batch.status === "verifying" && allTerminal
      ? hasErrors
        ? "completed_with_errors"
        : "completed"
      : batch.status;

  const { error } = await supabase
    .from("fev_batches")
    .update({
      status: nextStatus,
      valid_emails: validEmails,
      no_valid_emails: noValidEmails,
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  if (error) throw new Error("Could not update batch verification totals.");
  return getVerificationProgress(batchId);
}

export async function startBatchVerification(batchId: string) {
  const batch = await getBatch(batchId);

  if (batch.status === "completed" || batch.status === "completed_with_errors") {
    return getVerificationProgress(batchId);
  }

  if (batch.status === "verifying") {
    await reconcileSavedConclusiveAttempts(batchId);
    return recomputeBatch(batchId);
  }

  if (batch.status !== "uploaded" && batch.status !== "parsed") {
    throw new VerificationStateError(
      `Batch cannot be verified from status ${batch.status}.`,
      409,
    );
  }

  const { error } = await getSupabaseAdmin()
    .from("fev_batches")
    .update({ status: "verifying", updated_at: new Date().toISOString() })
    .eq("id", batchId)
    .in("status", ["uploaded", "parsed"]);

  if (error) throw new Error("Could not start batch verification.");
  await reconcileSavedConclusiveAttempts(batchId);
  return recomputeBatch(batchId);
}

async function reconcileMalformedPowerAttempts(
  attempts: AttemptForVerification[],
) {
  const supabase = getSupabaseAdmin();
  const reconciled = [...attempts];

  for (let index = 0; index < reconciled.length; index += 1) {
    const attempt = reconciled[index];
    if (
      attempt.verification_status !== "malformed" ||
      !attempt.raw_result ||
      Array.isArray(attempt.raw_result)
    ) {
      continue;
    }

    const result = normalizeReoonResult(attempt.raw_result);
    if (result.isError) continue;

    const { data, error } = await supabase
      .from("fev_verification_attempts")
      .update({
        verification_status: result.verificationStatus,
        is_safe_to_send: result.isSafeToSend,
        is_catch_all: result.isCatchAll,
        is_role_based: result.isRoleBased,
        is_disposable: result.isDisposable,
        error_message: result.errorMessage,
      })
      .eq("id", attempt.id)
      .eq("verification_status", "malformed")
      .select("id")
      .maybeSingle();

    if (error) throw new Error("Could not reconcile a saved Reoon result.");
    if (data) {
      reconciled[index] = {
        ...attempt,
        verification_status: result.verificationStatus,
        is_safe_to_send: result.isSafeToSend,
        error_message: result.errorMessage,
      };
    }
  }

  return reconciled;
}

async function reconcileSavedConclusiveAttempts(batchId: string) {
  const { data: founders, error } = await getSupabaseAdmin()
    .from("fev_founders")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "pending");

  if (error) throw new Error("Could not load saved verification attempts.");
  for (const founder of founders ?? []) {
    await reconcileMalformedPowerAttempts(await loadAttemptsForFounder(founder.id));
  }
}

async function reconcileExistingAttempts(
  batchId: string,
  founder: FounderForVerification,
  attempts: AttemptForVerification[],
): Promise<
  | { outcome: "terminal" }
  | { outcome: "busy" }
  | { outcome: "candidate"; email: string; candidateType: CandidateType }
> {
  attempts = await reconcileMalformedPowerAttempts(attempts);

  const accepted = attempts.find(isAcceptedAttempt);
  if (accepted) {
    await updateFounderValid(
      batchId,
      founder.id,
      accepted.candidate_email,
      accepted.candidate_type,
    );
    return { outcome: "terminal" };
  }

  const processing = attempts.find(
    (attempt) => attempt.verification_status === "processing",
  );
  if (processing) {
    if (isFreshProcessingAttempt(processing)) {
      return { outcome: "busy" };
    }
    await expireStaleAttempt(batchId, founder.id, processing);
    return { outcome: "terminal" };
  }

  if (attempts.some(isErrorAttempt)) {
    await updateFounderTerminal(batchId, founder.id, "verification_error");
    return { outcome: "terminal" };
  }

  const firstEmail = founder.first_candidate_email.trim().toLowerCase();
  const lastEmail = founder.last_candidate_email?.trim().toLowerCase() ?? null;
  const firstAttempt = attempts.find((attempt) =>
    sameEmail(attempt.candidate_email, firstEmail),
  );

  if (!firstAttempt) {
    return { outcome: "candidate", email: firstEmail, candidateType: "first_name" };
  }

  if (lastEmail && !sameEmail(firstEmail, lastEmail)) {
    const lastAttempt = attempts.find((attempt) =>
      sameEmail(attempt.candidate_email, lastEmail),
    );
    if (!lastAttempt) {
      return { outcome: "candidate", email: lastEmail, candidateType: "last_name" };
    }
  }

  await updateFounderTerminal(batchId, founder.id, "no_valid_email");
  return { outcome: "terminal" };
}

export async function processNextCandidate(
  batchId: string,
): Promise<VerificationStepResult> {
  const batch = await getBatch(batchId);
  if (batch.status === "completed" || batch.status === "completed_with_errors") {
    return { progress: await getVerificationProgress(batchId), outcome: "complete" };
  }
  if (batch.status !== "verifying") {
    throw new VerificationStateError("Start verification before processing candidates.", 409);
  }

  const supabase = getSupabaseAdmin();
  const { data: founder, error: founderError } = await supabase
    .from("fev_founders")
    .select("id, first_candidate_email, last_candidate_email, status")
    .eq("batch_id", batchId)
    .eq("status", "pending")
    .order("source_sheet_name", { ascending: true })
    .order("source_row", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (founderError) throw new Error("Could not select the next founder.");
  if (!founder) {
    return { progress: await recomputeBatch(batchId), outcome: "complete" };
  }

  const attempts = await loadAttemptsForFounder(founder.id);
  const next = await reconcileExistingAttempts(batchId, founder, attempts);

  if (next.outcome === "busy") {
    return { progress: await getVerificationProgress(batchId), outcome: "busy" };
  }
  if (next.outcome === "terminal") {
    return {
      progress: await recomputeBatch(batchId),
      outcome: "founder_reconciled",
    };
  }

  const { data: reservation, error: reservationError } = await supabase
    .from("fev_verification_attempts")
    .upsert(
      {
        founder_id: founder.id,
        candidate_type: next.candidateType,
        candidate_email: next.email,
        provider: "reoon",
        verification_status: "processing",
        is_safe_to_send: null,
        is_catch_all: null,
        is_role_based: null,
        is_disposable: null,
        raw_result: null,
        error_message: null,
      },
      {
        onConflict: "founder_id,candidate_email",
        ignoreDuplicates: true,
      },
    )
    .select("id")
    .maybeSingle();

  if (reservationError) {
    if (reservationError.code === "42P10") {
      throw new VerificationStateError(
        "The required verification-attempt uniqueness index is not installed.",
        503,
      );
    }
    throw new Error("Could not reserve the verification candidate.");
  }
  if (!reservation) {
    return { progress: await getVerificationProgress(batchId), outcome: "busy" };
  }

  return completeReservedVerification(batchId, founder, next, reservation.id);
}

async function completeReservedVerification(
  batchId: string,
  founder: FounderForVerification,
  next: { email: string; candidateType: CandidateType },
  reservationId: string,
): Promise<VerificationStepResult> {
  const supabase = getSupabaseAdmin();

  try {
    const result = await verifyEmailWithReoon(next.email);
    const { data: savedAttempt, error: attemptError } = await supabase
      .from("fev_verification_attempts")
      .update({
        verification_status: result.verificationStatus,
        is_safe_to_send: result.isSafeToSend,
        is_catch_all: result.isCatchAll,
        is_role_based: result.isRoleBased,
        is_disposable: result.isDisposable,
        raw_result: result.rawResult,
        error_message: result.errorMessage,
      })
      .eq("id", reservationId)
      .eq("verification_status", "processing")
      .select("id")
      .maybeSingle();

    if (attemptError) throw new Error("Could not save the Reoon result.");
    if (!savedAttempt) {
      return { progress: await recomputeBatch(batchId), outcome: "busy" };
    }

    if (result.accepted) {
      await updateFounderValid(
        batchId,
        founder.id,
        next.email,
        next.candidateType,
      );
    } else if (result.isError) {
      await updateFounderTerminal(batchId, founder.id, "verification_error");
    } else if (
      next.candidateType === "last_name" ||
      !founder.last_candidate_email ||
      sameEmail(founder.first_candidate_email, founder.last_candidate_email)
    ) {
      await updateFounderTerminal(batchId, founder.id, "no_valid_email");
    }
  } catch (error) {
    const message = sanitizedProviderError(error);
    const { data: savedAttempt, error: attemptError } = await supabase
      .from("fev_verification_attempts")
      .update({
        verification_status: "error",
        is_safe_to_send: null,
        is_catch_all: null,
        is_role_based: null,
        is_disposable: null,
        error_message: message,
      })
      .eq("id", reservationId)
      .eq("verification_status", "processing")
      .select("id")
      .maybeSingle();

    if (attemptError) throw new Error("Could not save the Reoon error.");
    if (savedAttempt) {
      await updateFounderTerminal(batchId, founder.id, "verification_error");
    }
  }

  return {
    progress: await recomputeBatch(batchId),
    outcome: "reserved_and_checked",
  };
}

export async function retryFailedVerification(
  batchId: string,
): Promise<VerificationStepResult> {
  const batch = await getBatch(batchId);
  const supabase = getSupabaseAdmin();
  const { data: failedFounders, error: foundersError } = await supabase
    .from("fev_founders")
    .select("id, first_candidate_email, last_candidate_email, status")
    .eq("batch_id", batchId)
    .eq("status", "verification_error")
    .order("source_sheet_name", { ascending: true })
    .order("source_row", { ascending: true })
    .order("id", { ascending: true });

  if (foundersError) throw new Error("Could not load failed verifications.");

  for (const founder of (failedFounders ?? []) as FounderForVerification[]) {
    const attempts = await loadAttemptsForFounder(founder.id);
    const attempt = attempts.find(isRetryableAttempt);
    if (!attempt || !attempt.verification_status) continue;

    const { data: reservation, error: reservationError } = await supabase
      .from("fev_verification_attempts")
      .update({
        verification_status: "processing",
        is_safe_to_send: null,
        is_catch_all: null,
        is_role_based: null,
        is_disposable: null,
        error_message: `Retrying failed verification. Previous reason: ${attempt.error_message ?? "provider failure"}`,
      })
      .eq("id", attempt.id)
      .eq("verification_status", attempt.verification_status)
      .select("id")
      .maybeSingle();

    if (reservationError) {
      throw new Error("Could not reserve the failed verification candidate.");
    }
    if (!reservation) continue;

    const { data: resetFounder, error: resetError } = await supabase
      .from("fev_founders")
      .update({
        status: "pending",
        verification_status: null,
        is_safe_to_send: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", founder.id)
      .eq("batch_id", batchId)
      .eq("status", "verification_error")
      .select("id")
      .maybeSingle();

    if (resetError) throw new Error("Could not reset the failed founder.");
    if (!resetFounder) {
      return { progress: await getVerificationProgress(batchId), outcome: "busy" };
    }

    const { error: batchError } = await supabase
      .from("fev_batches")
      .update({ status: "verifying", updated_at: new Date().toISOString() })
      .eq("id", batch.id);
    if (batchError) throw new Error("Could not resume batch verification.");

    return completeReservedVerification(
      batchId,
      founder,
      {
        email: attempt.candidate_email,
        candidateType:
          attempt.candidate_type === "last_name" ? "last_name" : "first_name",
      },
      reservation.id,
    );
  }

  throw new VerificationStateError("No retryable failed verification was found.", 409);
}
