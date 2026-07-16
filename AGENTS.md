# Founder Email Verifier

## Project overview

Founder Email Verifier is an internal operations application that turns company-and-founder data from an Excel workbook into a deduplicated, verified list of founder email addresses ready for Smartlead. It is designed to protect sending reputation and paid Reoon credits: duplicate founders are not imported, candidates are checked sequentially, and an address is accepted only when Reoon explicitly reports that it is both valid and safe to send.

The application uses Next.js 16 App Router, React 19, TypeScript, Supabase, and the Reoon Email Verifier Power-mode API. Supabase is accessed from server-only code with the service-role key.

## End-to-end workflow

1. An operator selects an `.xlsx` workbook and requests a preview.
2. The server validates and parses all usable sheets, extracts up to four founders per company row, normalizes names and domains, and creates first-name and last-name email candidates.
3. The preview labels founders as ready or duplicate and reports processed sheets, skipped sheets, invalid rows, companies, founders, and duplicates.
4. After the operator supplies a batch name, import repeats parsing and duplicate classification on the server. It creates one batch and inserts only ready founders.
5. An administrator confirms the credit-spending action and starts verification. The client requests one candidate check at a time.
6. Reoon Power mode checks the first-name candidate first. A strictly valid and safe result selects that email immediately; otherwise, the last-name candidate is checked when one exists.
7. The batch page continuously reports progress and exposes founder outcomes and attempt history. Work can be paused and resumed without rechecking conclusive candidates.
8. Failed provider or malformed-response attempts can be retried explicitly, one at a time.
9. When processing is terminal, the batch becomes `completed` or `completed_with_errors`.
10. The operator exports only valid, safe, selected, deduplicated emails as a Smartlead-compatible CSV.

## Workbook upload and founder extraction

- Accept only non-empty `.xlsx` files up to 15 MB.
- Scan the first 25 rows of every sheet for a header row containing `company_name`, `website`, and at least one supported founder field.
- Supported founder fields are `founder_name`, `founder_2`, `founder_3`, and `founder_4`. Associated LinkedIn fields are `linkedin_url`, `linkedin_url_2`, `linkedin_url_3`, and `linkedin_url_4`. The first founder may also use `founder_role`.
- Optional company metadata is carried forward from `yc_batch`, `industry`, `description`, and `country`.
- Process every sheet with the required headers and report sheets without them as skipped.
- Ignore completely blank data rows.
- Record an invalid source row when it has no founder, lacks a company name, has no usable website domain, or contains a founder name with no usable Latin characters. Multiple reasons for the same source row are combined.
- Normalize websites to a lowercase hostname, remove a leading `www.`, and reject whitespace, invalid labels, missing dots, or overlong domains.
- Normalize founder names by removing bracketed notes, transliterating supported characters, removing diacritics and punctuation, and stripping common honorifics and suffixes. The first remaining token is the first name and the last remaining token is the last name.
- Preserve the source sheet and 1-based source row for traceability.
- Preview is non-persistent. Import reparses and reclassifies the uploaded file; never trust preview data sent back by the browser.
- Batch names are required and limited to 120 characters. Source filenames are stored at no more than 255 characters.
- If founder insertion fails after batch creation, delete the newly created batch so a partial import is not retained.

## Candidate generation

Generate candidates from normalized lowercase values in this exact order:

1. `first_name@normalized_domain`
2. `last_name@normalized_domain`, only when a last name exists and the address differs from the first candidate

Do not invent additional patterns. Verification always tries the first-name candidate before the last-name candidate. Stop checking a founder immediately after a candidate passes the strict acceptance rule.

## Duplicate prevention

A founder's application-level duplicate identity is the pair:

`normalized_founder_name + normalized_domain`

Duplicate classification checks existing records in `fev_founders` and also tracks names already seen within the current workbook. The first unseen occurrence is ready; later occurrences are duplicates. Only ready founders are inserted. Batch reports retain the number skipped as duplicates.

Verification attempts use a separate idempotency key: `(founder_id, candidate_email)`. The database must provide the matching uniqueness constraint/index used by the upsert. A candidate is reserved as `processing` before a Reoon request, preventing concurrent workers or repeated browser requests from spending credits on the same founder candidate.

## Reoon verification and strict acceptance

- Use `https://emailverifier.reoon.com/api/v1/verify` with `mode=power`, server-side only, and an 85-second request timeout.
- A response is structurally usable only when it includes an email, a status, Power verification mode, and a boolean `is_safe_to_send`.
- Accept a candidate only when all of these are true:
  - normalized Reoon status is exactly `safe`;
  - `is_safe_to_send` is exactly `true`;
  - no blocking flag or condition is present.
- Blocking results include catch-all, role-based/role-account, disposable/temporary, spam trap, disabled, inbox full, undeliverable, invalid syntax, rejected MX, or failed SMTP connection.
- `unknown`, `risky`, `invalid`, `unsafe`, and every other non-accepted status are not valid. Unknown is always normalized to not safe to send.
- A Reoon status of `valid` alone maps to unsafe; it does not satisfy the project's stricter rule.
- Save every provider result and its raw payload in `fev_verification_attempts`, together with normalized status and safety flags.
- Never select or export an email unless the founder is `valid`, the selected attempt is normalized to `valid`, and `is_safe_to_send` is `true`.
- If a valid and safe candidate conflicts with the `fev_unique_selected_email` constraint, preserve the valid attempt and mark the founder `duplicate_email` with no selected email or pattern. Do not try another candidate or call Reoon again for that founder.
- If the first candidate is conclusive but not accepted, try the distinct last-name candidate. If that candidate also fails the rule, or no last candidate exists, mark the founder `no_valid_email`.
- Provider failures, timeouts, malformed responses, and unrecognized statuses mark the founder `error`; they are not treated as ordinary invalid emails.

## Pause, resume, reconciliation, and retry

- Verification is deliberately sequential: each `/verification/next` request processes or reconciles one founder candidate.
- Pausing stops the browser loop after aborting the active browser request. Persisted database state remains the source of truth.
- Starting a batch already in `verifying` state resumes it. Saved accepted attempts are reconciled into founder results before new work proceeds.
- Existing conclusive attempts are never charged again. If the first candidate was already checked and rejected, resume with the last candidate when applicable.
- A fresh `processing` reservation is treated as busy. A reservation older than three minutes is closed as an error and its founder becomes `error`; it is never silently reissued by the normal resume path.
- Previously saved malformed Power-mode payloads are re-normalized during reconciliation. If the payload is actually conclusive under current normalization, update the saved attempt without calling Reoon again.
- Explicit retry is limited to failed provider, timeout, error, malformed, or malformed-response attempts, including recognized incomplete/malformed Power-result messages. Conclusive invalid or unsafe results cannot be retried.
- Each retry reserves and checks one failed attempt, resets that founder to pending, and returns the batch to `verifying`. Continue normal processing after the retry result.
- Terminal founder states are `valid`, `duplicate_email`, `no_valid_email`, and `error`.
- A batch becomes `completed` when every founder is terminal and none has a verification error; otherwise it becomes `completed_with_errors`. Stored valid/no-valid totals are recomputed from founder rows.

## Batch reporting

The dashboard reports total batches, total founders, pending founders, and recent batches. The batch list shows source file, status, company count, founder count, duplicate count, and creation time.

Each batch detail page reports:

- total, processed, remaining, and percentage complete;
- valid emails, duplicate-email outcomes, no-valid-email outcomes, verification errors, and candidate attempt count;
- up to 20 recent error summaries in the progress response;
- outcome filters for all, valid, duplicate email, no valid email, errors, and pending;
- paginated founder results, up to 100 rows per page;
- source sheet/row, company/domain, both candidates, selected email/pattern, final status, and verification status;
- full attempt history with provider, time, normalized status, safe-to-send, catch-all, role-based, disposable, and sanitized error details;
- duplicates skipped and stored operational totals.

Treat current founder records as authoritative for displayed outcome counts. Batch counters are operational snapshots recomputed during verification.
Duplicate-email outcome totals are derived from founder rows and are not stored in a separate batch counter.

## Smartlead CSV export

- Export only founders in the requested batch where `status = valid`, `is_safe_to_send = true`, and `selected_email` is not null.
- Normalize selected emails to lowercase and remove duplicates within the export.
- Emit a UTF-8 BOM and CRLF line endings for spreadsheet compatibility.
- Escape CSV values correctly and prefix cells beginning with `=`, `+`, `-`, or `@` with an apostrophe to prevent spreadsheet-formula injection.
- Export columns, in order, are: `email`, `first_name`, `last_name`, `full_name`, `company_name`, `website`, `domain`, `linkedin_url`, `yc_batch`, `industry`, `country`, `source_file`, `batch_name`, and `selected_pattern`.
- Derive display first/last names from the original founder name for export.
- Use the filename format `smartlead-<batch-slug>-YYYY-MM-DD.csv`.
- Return an error rather than an empty file when no valid and safe founders are available.

## Database tables

### `fev_batches`

One row per import. Important fields: batch/source names, lifecycle status, total companies, total founders, duplicate founders, valid emails, no-valid emails, and timestamps. Statuses are `uploaded`, `parsed`, `verifying`, `completed`, and `completed_with_errors`.

### `fev_founders`

One row per unique imported founder. Stores source location, company metadata, original and normalized identity, parsed first/last names, LinkedIn URL, both candidate emails, selected email and pattern, founder/verification status, safe-to-send decision, export timestamp, and timestamps. Founder statuses are `pending`, `valid`, `duplicate_email`, `no_valid_email`, and `error`.

### `fev_verification_attempts`

One row per founder candidate. Stores candidate type/address, provider, normalized verification status, safety and risk flags, raw provider payload, sanitized error message, and attempt time. `(founder_id, candidate_email)` must be unique for reservation idempotency. Attempt statuses include `processing`, `valid`, conclusive unsafe categories, and error categories defined in `src/lib/database.types.ts`.

The database schema is managed outside this repository; no migration files are currently present here. Keep `src/lib/database.types.ts` aligned with deployed tables whenever the schema changes.

## Security and operational rules

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `REOON_API_KEY`, `FEV_ADMIN_PASSWORD`, and `FEV_SESSION_SECRET` server-side. Never expose them through client components, `NEXT_PUBLIC_*` variables, logs, errors, CSV output, or committed files.
- `NEXT_PUBLIC_SUPABASE_URL` is public by design; the service-role key is not.
- Credit-spending verification endpoints require both a same-origin request and a valid administrator session.
- Administrator passwords are compared with timing-safe equality. Successful authentication creates an HMAC-signed, HTTP-only, SameSite Strict cookie with an eight-hour lifetime; it is marked Secure when served over HTTPS.
- Use a unique `FEV_SESSION_SECRET` of at least 32 random characters. The service-role key is only a fallback signing secret; configure the dedicated secret in every environment.
- Never call Reoon from the browser. Do not return raw provider secrets or unsanitized provider errors to clients.
- Require explicit operator confirmation before consuming Reoon credits or retrying a failed check.
- Preserve formula-injection protection in CSV exports.
- Do not weaken the valid-and-safe rule, add speculative email patterns, retry conclusive results, or bypass duplicate/attempt reservations without an explicit product decision.
- Treat `.env.local` and all `.env*` files except `.env.example` as secrets; they are gitignored.

## Environment variables

Copy `.env.example` to `.env.local` and configure:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only privileged database access. |
| `REOON_API_KEY` | Yes for verification | Server-only Reoon Power-mode API credential. |
| `FEV_ADMIN_PASSWORD` | Yes for verification | Password used to authorize credit-spending actions. |
| `FEV_SESSION_SECRET` | Yes | At least 32 random characters for signing administrator sessions. |

## Development workflow

Install dependencies and use the package scripts:

```bash
npm install
npm run dev
npm run lint
npm run build
npm run start
```

- `npm run dev` starts local development.
- `npm run lint` runs ESLint.
- `npm run build` performs the production build and is the minimum release verification.
- `npm run start` serves an existing production build.
- No automated test script is currently defined. For workflow changes, run lint and build, then manually exercise preview, import, pause/resume, failure retry, reporting filters, and export against a non-production Supabase/Reoon setup.

### Next.js implementation rule

This is not the Next.js version assumed by older training material. Next.js 16 has breaking API, convention, and file-structure changes. Before changing application code, read the relevant guide under `node_modules/next/dist/docs/` and follow its current deprecation guidance.

## Completed features

- Multi-sheet XLSX validation, header detection, preview, and import.
- Multi-founder extraction with source traceability and invalid-row reporting.
- Name/domain normalization and deterministic first/last candidate generation.
- Cross-database and within-workbook founder deduplication.
- Batch creation with partial-import cleanup.
- Sequential Reoon Power-mode verification with strict valid-and-safe acceptance.
- Idempotent attempt reservation, saved raw results, reconciliation, pause/resume, stale-attempt handling, and explicit failed-attempt retry.
- Administrator confirmation/session protection for credit-spending endpoints.
- Dashboard, batch list, progress metrics, result filters, pagination, and per-candidate history.
- Smartlead-compatible, deduplicated, formula-safe CSV export.

## Change checklist

When modifying the workflow:

1. Preserve server-side validation and never trust browser-supplied preview state.
2. Keep duplicate identity and attempt idempotency rules consistent across preview, import, database constraints, and verification.
3. Keep Reoon normalization conservative: ambiguous data must never become valid.
4. Keep founder and batch lifecycle transitions resumable from persisted state.
5. Keep reports and exports derived from current founder outcomes.
6. Update database types and this document when statuses, fields, constraints, or operational behavior change.
7. Run `npm run lint` and `npm run build` before handoff.
