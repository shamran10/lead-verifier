export function StatusPill({ status }: { status: string }) {
  const tone = getStatusTone(status);
  return (
    <span className={`status-pill status-pill-${tone}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

function getStatusTone(status: string) {
  if (["valid", "safe"].includes(status)) return "success";
  if (["verifying", "processing"].includes(status)) return "active";
  if (["no_valid_email", "duplicate"].includes(status)) return "warning";
  if (
    [
      "catch_all",
      "duplicate_email",
      "unknown",
      "role_based",
      "disposable",
      "risky",
      "spamtrap",
      "invalid",
      "disabled",
      "inbox_full",
      "unsafe",
    ].includes(status)
  ) {
    return "blocked";
  }
  if (
    [
      "completed_with_errors",
      "malformed",
      "malformed_response",
      "provider_error",
      "timeout",
      "error",
    ].includes(status)
  ) {
    return "error";
  }
  return "neutral";
}
