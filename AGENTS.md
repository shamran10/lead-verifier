# Founder Email Verifier

## Project overview

Founder Email Verifier is an internal operations application that turns Y Combinator or eligible 500 Global or Techstars company-and-founder data from an Excel workbook into a deduplicated, verified list of founder email addresses ready for Smartlead. It is designed to protect sending reputation and paid Reoon credits: duplicate founders are not imported, candidates are checked sequentially, and an address is accepted only when Reoon explicitly reports that it is both valid and safe to send.

The application uses Next.js 16 App Router, React 19, TypeScript, Supabase, and the Reoon Email Verifier Power-mode API. Supabase is accessed from server-only code with the service-role key.

## End-to-end workflow

1. An operator selects the YC or 500 Global source type, chooses an `.xlsx` workbook, and requests a preview. YC is the backward-compatible default.
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
- YC imports retain the original header, validation, `yc_batch`, reporting, verification, and export behavior. They do not require accelerator year, eligible geography, or a source URL.
- 500 Global sheets additionally require `accelerator_year`, `country`, and `source_url`. `accelerator_batch` is optional. The server sets `accelerator_name` to `500 Global`; uploaded accelerator-name values are never trusted.
- A 500 Global row is eligible only when its accelerator year is exactly 2025 or 2026, its company headquarters/current country resolves to Europe or North America, and its source URL is a valid HTTPS URL on an approved official host. `500.co` and its subdomains are currently approved. URL validation supports manual provenance review but does not prove the page publication date.
- North America currently means the United States, Canada, and Mexico. Europe includes the United Kingdom, EU and EEA countries, Switzerland, and other unambiguously European countries. Russia, Turkey, Armenia, Azerbaijan, and Georgia are excluded. Ambiguous, city-only, multi-country, Remote, Global, and unknown values are rejected rather than inferred.
- Geography always uses the company country, never the accelerator program location. Accepted 500 Global countries are stored canonically and their derived region is stored as `europe` or `north_america`.
- 500 Global validation collects all applicable row errors so rejected rows remain visible in preview. At least one founder name must normalize successfully.
- Process every sheet with the required headers and report sheets without them as skipped.
- Ignore completely blank data rows.
- Record an invalid source row when it has no founder, lacks a company name, has no usable website domain, or contains a founder name with no usable Latin characters. Multiple reasons for the same source row are combined.
- Normalize websites to a lowercase hostname, remove a leading `www.`, and reject whitespace, invalid labels, missing dots, or overlong domains.
- Normalize founder names by removing bracketed notes, transliterating supported characters, removing diacritics and punctuation, and stripping common honorifics and suffixes. The first remaining token is the first name and the last remaining token is the last name.
- Preserve the source sheet and 1-based source row for traceability.
- Preview is non-persistent. Import reparses and reclassifies the uploaded file; never trust preview data sent back by the browser.
- Preview and import accept `sourceType` values `yc`, `500_global`, and `techstars`. A missing value means `yc` for backward compatibility; every other value is rejected server-side.

### Techstars workbook imports

- Techstars uses the accelerator workbook contract: `company_name`, `website`, `accelerator_year`, `country`, `source_url`, and at least one supported founder field are required headers.
- The server sets `accelerator_name` to `Techstars`; uploaded accelerator-name values are never trusted.
- Techstars rows require year 2025 or 2026, an eligible company country, and an HTTPS official source on `techstars.com` or its subdomains.
- Geography uses company headquarters/current country, never the Techstars program location.
- Batch names are required and limited to 120 characters. Source filenames are stored at no more than 255 characters.
- If founder insertion fails after batch creation, delete the newly created batch so a partial import is not retained.

## Candidate generation

Generate candidates from normalized lowercase values in this exact order:

1. `first_name@normalized_domain`
2. `last_name@normalized_domain`, only when a last name exists and the address differs from the first candidate

Do not invent additional patterns. Verification always tries the first-name candidate before the last-name candidate. Stop checking a founder immediately after a candidate passes the strict acceptance rule.

## 500 Global Lead Finder discovery workflow

The Lead Finder at `/500-global` is separate from spreadsheet upload. It is administrator-driven and establishes a persistent discovery, enrichment, review, and import boundary:

1. An administrator creates a bounded run for 2025 and/or 2026, Europe and/or North America, at most 1,000 records, and optionally marks it as a dry run.
2. The system seeds verified official sources and may accept curated HTTPS source URLs. `500.co` and its subdomains are approved by default; any partner host requires explicit administrator approval. URLs are normalized and unique within a run. Unsafe protocols, localhost, private/metadata addresses, and obvious non-public hosts are rejected.
3. The resumable source processor handles one approved source per request, enforces robots/DNS/redirect/size/timeout protections, extracts official participants, and stores provenance without calling Reoon.
4. Roster countries are official participant-location evidence, never accelerator-program location. Recognized outside-region locations may establish ineligibility; target-region roster locations remain provisional until company-owned evidence or an operator confirms them.
5. Company enrichment handles at most one leased company per request and checks no more than five same-origin public pages: homepage, about, team, company, and contact. It stores snippets and hashes, never full HTML, and never requests LinkedIn. Only directly linked public LinkedIn URLs may be retained as evidence.
6. Eligibility is pure and evidence-driven: confirmed outside the run's regions is `ineligible`; confirmed target geography plus an evidence-backed active founder is `eligible`; missing/conflicting geography or a missing/uncertain founder remains `needs_review`. The default Action Required view excludes conclusively ineligible audit rows.
7. Discovery companies and founders are displayed through a server-paginated review table. Administrators may correct company metadata and approve, reject, include, or exclude records until import. Manual decisions are not overwritten by later automation, and imported records are immutable in the discovery UI.
8. `Import Approved` is blocked for dry runs. It converts only approved, included, confirmed records to the shared `ParsedFounder` DTO and calls the same batch/founder import service used by workbook imports.
9. A discovery run can create only one linked parsed batch. Retries reconcile that batch, global founder duplicate identity remains unchanged, and no verification attempts are created.
10. Reoon verification never starts automatically. The administrator must open the existing batch page and explicitly start verification later.

## Duplicate prevention

A founder's application-level duplicate identity is the pair:

`normalized_founder_name + normalized_domain`

Duplicate classification checks existing records in `fev_founders` and also tracks names already seen within the current workbook. The first unseen occurrence is ready; later occurrences are duplicates. Only ready founders are inserted. Batch reports retain the number skipped as duplicates.

Duplicate identity is global across YC, 500 Global, and Techstars. Do not include `source_type` in the identity or allow the same founder/domain pair to consume verification credits through a different accelerator source.

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

Batch lists and detail pages also show the batch source. YC founder review retains `yc_batch`; 500 Global review shows accelerator name, batch, year, canonical company country, derived region, and the official source URL for manual auditing.

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
- YC Smartlead and Catch-All export headers and ordering are unchanged. For 500 Global batches, the existing columns remain in place, `yc_batch` is blank, and `source_type`, `accelerator_name`, `accelerator_batch`, `accelerator_year`, `accelerator_region`, and `source_url` are appended.
- Catch-All exports remain attempt-level, force `verification_status = catch_all`, `is_catch_all = true`, and `is_safe_to_send = false`, and deduplicate normalized candidate emails.
- Derive display first/last names from the original founder name for export.
- Use the filename format `smartlead-<batch-slug>-YYYY-MM-DD.csv`.
- Return an error rather than an empty file when no valid and safe founders are available.

## Database tables

### `fev_batches`

One row per import. Important fields: batch/source names, `source_type`, nullable unique `discovery_run_id`, lifecycle status, total companies, total founders, duplicate founders, valid emails, no-valid emails, and timestamps. Source types are `yc`, `500_global`, and `techstars`. Statuses are `uploaded`, `parsed`, `verifying`, `completed`, and `completed_with_errors`.

## Standalone Techstars lead exporter

The Techstars exporter has three resumable, database-independent stages. `npm run lead:techstars:discover` validates official 2025/2026 participation evidence from the maintained catalog, paginated Techstars indexes, linked official sources, and optional Brave searches restricted to `techstars.com`; it requires a usable company website, deduplicates companies, and writes founder-free derived data to `.cache/techstars/discovered-companies.json`. `npm run lead:techstars:filter` reads that dataset, uses company-specific official roster locations first and up to five same-origin company pages second to classify geography without collecting founders, then writes `.cache/techstars/filtered-companies.json` and `exports/Techstars_2025_2026_Companies.xlsx`. Participant-level city/state and city/province values use explicit US-state and Canadian-province maps; accelerator program names never establish company location. Its sheets are `Europe and North America`, `Unresolved Location`, `Excluded Geography`, and `Blocked Sources`.

`npm run lead:techstars:enrich` reads only Europe/North America companies from Stage 2, performs bounded founder enrichment, and writes `exports/Techstars_2025_2026_Europe_North_America.xlsx`. Only `Ready for Upload` is import-compatible; `Needs Founder Review`, `Excluded`, and `Blocked Sources` are diagnostic. `npm run lead:techstars` runs all three stages in sequence. Every stage supports `--resume` and `--fresh`, and none writes to Supabase, calls Reoon, imports automatically, or fetches LinkedIn pages.

### `fev_founders`

One row per unique imported founder. Stores source location, company metadata, original and normalized identity, parsed first/last names, LinkedIn URL, both candidate emails, selected email and pattern, founder/verification status, safe-to-send decision, export timestamp, and timestamps. YC metadata remains in nullable `yc_batch`. 500 Global metadata uses nullable `accelerator_name`, `accelerator_batch`, `accelerator_year`, `accelerator_region`, and `source_url`; existing historical founders keep these fields null. Founder statuses are `pending`, `valid`, `duplicate_email`, `no_valid_email`, and `error`.

### `fev_verification_attempts`

One row per founder candidate. Stores candidate type/address, provider, normalized verification status, safety and risk flags, raw provider payload, sanitized error message, and attempt time. `(founder_id, candidate_email)` must be unique for reservation idempotency. Attempt statuses include `processing`, `valid`, conclusive unsafe categories, and error categories defined in `src/lib/database.types.ts`.

### 500 Global discovery tables

- `fev_500global_runs` stores run configuration, lifecycle, operational counters, dry-run state, and the linked imported batch.
- `fev_500global_sources` stores normalized curated URLs, explicit host approval, source/processing status, future fetch metadata, retry leases, and extraction placeholders. Phase 1 leaves processing pending.
- `fev_500global_discovered_companies` stores discovery-only company metadata, evidence-derived eligibility, review/import/enrichment states, reasons, warnings, and final batch linkage.
- `fev_500global_discovered_founders` stores discovery-only founder identity, active/review/duplicate/import states, inclusion choice, warnings, and existing/imported founder linkage.
- `fev_500global_evidence` is the field-level provenance boundary. Use `500_global_official` for roster evidence and `company_official` for company-owned website evidence.
- `fev_500global_events` stores sanitized run, source, company, founder, and import audit events. It must never contain secrets, raw stack traces, or Reoon data.

Discovery records stay separate from `fev_founders` until explicit approval and import.

The database schema is managed outside this repository; no migration files are currently present here. Keep `src/lib/database.types.ts` aligned with deployed tables whenever the schema changes.

## Standalone 500 Global lead exporter

`npm run lead:500global` is a local, database-independent exporter for officially published 500 Global participant companies attributed to 2025 or 2026. It discovers candidates from the maintained catalog and official indexes, optionally augments discovery through the Brave Search API, validates bounded participant sources, enriches company-owned pages, and writes an upload-compatible workbook. It never writes to Supabase, calls Reoon, imports records, or fetches authenticated LinkedIn pages.

Supported source categories are `announcement`, `cohort_roster`, `demo_day`, `event_page`, `regional_program`, `partner_program`, and `manual_catalog`. A page must pass official or explicitly approved-host, year, attribution, participant-assertion, and bounded-section checks before it may produce company rows. Application-only pages, general program descriptions, historical portfolios, and unrelated speakers, sponsors, mentors, or placeholders are rejected.

Run the default export with:

```bash
npm run lead:500global
```

Options include `--years=2025,2026`, `--regions=europe,north_america`, `--resume`, `--fresh`, `--source-concurrency=1|2`, `--company-concurrency=1|2|3`, and `--host-spacing-ms=2000`. Same-host spacing cannot be lowered below two seconds. `BRAVE_SEARCH_API_KEY` is optional; without it, the exporter continues with maintained and official-index discovery and reports partial coverage.

The default workbook is `exports/500_Global_2025_2026_Europe_North_America.xlsx` and contains:

- `Ready for Upload`: exact 500 Global upload columns, confirmed eligible location, usable website, and at least one active founder.
- `Needs Review`: unresolved location, founder, website, source-fetch, and coverage diagnostics. Its headers intentionally prevent this sheet from being imported by the upload parser.
- `Excluded`: confirmed outside-region companies, duplicate audit rows, and rejected source candidates. Its headers likewise prevent accidental import.

The command validates the completed workbook with the same source-aware parser used by `/upload`; only `Ready for Upload` may be recognized as importable. Coverage is best-effort, not a guarantee of every worldwide participant. The required wording is: “All matching companies found from verified official sources currently discovered and supported by the exporter.”

Operational workflow: run the command, inspect all three sheets, resolve any useful `Needs Review` rows outside the generated workbook, then upload the file through `/upload` as a 500 Global source. Review the imported founders before manually starting Reoon verification, and only then use the existing valid or Catch-All exports.

## Security and operational rules

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `REOON_API_KEY`, `FEV_ADMIN_PASSWORD`, and `FEV_SESSION_SECRET` server-side. Never expose them through client components, `NEXT_PUBLIC_*` variables, logs, errors, CSV output, or committed files.
- `NEXT_PUBLIC_SUPABASE_URL` is public by design; the service-role key is not.
- Credit-spending verification endpoints require both a same-origin request and a valid administrator session.
- All discovery pages require the existing administrator session. Discovery POST/PATCH routes additionally enforce same-origin requests and always return JSON errors.
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
| `BRAVE_SEARCH_API_KEY` | No | Enables optional API-based official-source discovery for the standalone 500 Global exporter; never scrape search-result HTML. |

## Development workflow

Install dependencies and use the package scripts:

```bash
npm install
npm run dev
npm run lint
npm run build
npm run lead:500global
npm run lead:techstars:discover
npm run lead:techstars:filter
npm run lead:techstars:enrich
npm run start
```

- `npm run dev` starts local development.
- `npm run lint` runs ESLint.
- `npm run build` performs the production build and is the minimum release verification.
- `npm run lead:500global` creates the standalone review workbook without database or Reoon activity.
- `npm run lead:techstars` runs the three-stage Techstars company discovery, geography filtering, and founder-enrichment workflow.
- `npm run start` serves an existing production build.
- `npm run test:500-global` runs the focused country, eligibility, safe-fetch, source extraction, and company-enrichment tests. For workflow changes, also run lint and build, then manually exercise the affected paths against a non-production Supabase/Reoon setup.

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
- Source-specific YC and 500 Global preview/import metadata with company-country eligibility and official-source auditing.
- Source-aware batch review and source-specific exports that preserve the legacy YC schemas.
- Bounded, resumable 500 Global source processing and company-owned headquarters/founder enrichment with evidence provenance and no automatic downstream verification.

## Change checklist

When modifying the workflow:

1. Preserve server-side validation and never trust browser-supplied preview state.
2. Preserve the YC parser and exact YC export schemas when adding or changing another source.
3. Keep duplicate identity and attempt idempotency rules consistent across preview, import, database constraints, and verification.
4. Keep Reoon normalization conservative: ambiguous data must never become valid.
5. Keep founder and batch lifecycle transitions resumable from persisted state.
6. Keep reports and exports derived from current founder outcomes.
7. Update database types and this document when statuses, fields, constraints, or operational behavior change.
8. Run `npm run lint` and `npm run build` before handoff.
