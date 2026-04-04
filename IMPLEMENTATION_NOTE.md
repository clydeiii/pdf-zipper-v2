# Self-Healing Upgrade Note

## Plan Summary
The upgrade focused on four goals:

1. Improve reliability by reducing repeated dead-end retries (captcha/paywall/auth walls).
2. Make autonomous fixing safer and more controllable with explicit gates.
3. Increase diagnosis diversity by alternating between Claude and Codex.
4. Improve operator control and visibility with API/UI batch status and apply flow.

## Why This Plan
The original system could diagnose/fix issues, but it had key operational gaps:

1. No durable retry-memory beyond short dedupe windows.
2. No provider abstraction (single CLI path and brittle output parsing).
3. No hard verification gate before considering an auto-fix "ready".
4. Weak security boundaries on some mutating routes and path checks.

The chosen design addresses those issues with:

1. A persistent ledger and cooldown policy.
2. Round-robin provider orchestration with structured output validation.
3. Build + replay verification gate.
4. Optional API token auth and stronger path containment checks.

## Implemented Changes

### 1) Retry Memory + Trigger Policy
Added persistent fix-ledger and classification/policy modules:

- `src/fix/failure.ts`
- `src/fix/trigger-policy.ts`
- `src/fix/ledger.ts`

What this adds:

1. Failure class normalization (paywall/captcha/auth/bot/timeout/etc.).
2. Class-based cooldowns.
3. Outcome tracking (`queued`, `skipped`, `ready`, `applied`, etc.).
4. Append-only event log for fix actions.

### 2) Fix Queue Storage Improvements
Updated pending/history handling in:

- `src/fix/pending.ts`

Key changes:

1. Atomic consume of pending fixes (`MULTI` read+clear pattern).
2. Pending URL dedupe set.
3. Cooldown-aware enqueue with manual override support.
4. Batch detail storage and retrieval (`getFixBatch`, `updateFixBatch`).

### 3) Provider Abstraction + Round-Robin
Added provider runtime layer:

- `src/fix/providers.ts`

What it does:

1. Round-robin primary provider selection between Claude and Codex.
2. Optional forced provider override.
3. Structured JSON extraction/validation from provider output.
4. Single fallback attempt to alternate provider.

### 4) Gated Fix Worker
Replaced fix worker implementation:

- `src/workers/fix.worker.ts`

New behavior:

1. Consume pending contexts.
2. Diagnose via provider runtime.
3. Prepare fix branch/commit for changed allowed files.
4. Verification gate:
   - build (`npm run build --silent`)
   - targeted replay conversion jobs
5. Persist gate status (`diagnosed/patched/verifying/ready/rejected/applied/failed`).
6. Update ledger outcomes and send richer notifications.

### 5) Selective Auto-Fix Trigger From Conversion Failures
Updated:

- `src/workers/conversion.worker.ts`

Behavior:

1. On final failure, classify error.
2. Auto-submit only if policy allows.
3. Skip known hard blockers automatically, while still allowing manual submission.
4. Record ledger outcomes for skipped/queued items.

### 6) Weekly Index for Efficiency
Added:

- `src/jobs/week-index.ts`

Integrated into:

- `src/workers/conversion.worker.ts`
- `src/api/routes/files.ts`

Benefit:

1. Week failure/rerun endpoints now use Redis weekly indexes first.
2. Fallback to full queue scans for older historical jobs.

### 7) Security Hardening
Added:

- `src/api/auth.ts`
- `src/utils/paths.ts`

Applied to mutating routes:

- `src/api/routes/files.ts`
- `src/api/routes/fix.ts`
- `src/api/routes/cookies.ts`

Path safety improvements applied to:

- `src/api/routes/download.ts`
- `src/api/routes/serve.ts`
- `src/api/routes/files.ts`
- `src/api/routes/fix.ts`

### 8) Fix APIs + UI Operator Flow
Updated backend:

- `src/api/routes/fix.ts`

New endpoints:

1. `GET /api/fix/ledger?url=...`
2. `GET /api/fix/batches/:batchId`
3. `POST /api/fix/batches/:batchId/reverify`
4. `POST /api/fix/batches/:batchId/apply`

Updated frontend:

- `public/index.html`
- `public/app.js`
- `public/style.css`

UI additions:

1. Fix Center modal for batch visibility.
2. Apply/reverify actions.
3. API token prompt and local storage for authenticated mutating calls.

### 9) Config Surface Updates
Updated:

- `src/config/env.ts`
- `.env.example`
- `docker-compose.yml`

New env controls include:

1. `CODEX_CLI_PATH`
2. `CODEX_CLI_ARGS`
3. `API_AUTH_TOKEN`
4. `FIX_PROVIDER_TIMEOUT_MINUTES`

## Risks / Follow-Ups

1. No comprehensive integration tests yet for full provider+git+replay flow.
2. Provider CLIs must be configured correctly in runtime environment.
3. Build/test gate is currently build + replay; lint/static policy can be added later.

## Current Validation

1. TypeScript build passes (`npm run build --silent`).
2. Unit tests added for classification/trigger/path modules (see `test/`).
