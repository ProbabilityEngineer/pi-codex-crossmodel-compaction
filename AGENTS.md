# pi-codex-crossmodel-compaction Guidelines

## Project

- This is a standalone Pi extension package, extracted from
  `jvm/pi-mono/packages/pi-codex-compaction`.
- Runtime extension entry point: `extensions/index.ts`; implementation:
  `src/`; tests: `tests/`.
- The test suite is self-contained. Shared Pi harness and cooperating-extension
  fixtures live under `tests/support/` and `tests/fixtures/`; do not restore
  imports from sibling repositories.
- Use Pi's public extension API. Read the installed Pi extension/package docs
  when lifecycle or package integration changes.

## Invariants

- Use RemoteCompactionV2 only for `openai-codex` models on
  `openai-codex-responses`.
- Ordinary opaque checkpoint reuse remains bound to compatible model, endpoint,
  account fingerprint, and authentication kind. Never weaken these checks.
- Cross-model transition is best-effort and originates only from an explicit
  `model_select`; never infer/retry transitions on provider or tool continuation.
- Transition compaction uses the source model and complete, correctly bounded
  branch tail. Preserve tool-call/result pairing and do not duplicate Pi-kept
  user input.
- Keep the bounded readable textual fallback available. Ambiguous, stale,
  failed, or incompatible transitions must fail open to readable context.
- Never introduce general context/overflow recovery or automatic logical-request
  replay as part of transition work.
- Keep request/response bounds, HTTPS restrictions, cancellation behavior, and
  secret/prompt/provider-response privacy. Never log credentials, headers,
  prompts, or opaque checkpoint contents.
- Persisted transition records are versioned and terminal; incomplete
  transitions reconstructed after restart resolve to fallback.

## Validation

```bash
npm run check
npm test
npm run typecheck
npm run pack:dry-run
```

- `npm run lint` and `npm run build` are not currently configured.
- Keep tests self-contained; do not read or write outside the repository except
  for explicit temporary diagnostics that are removed after use.
- Inspect `git status`, the complete diff, and `git diff --check` before
  finishing. Do not commit, publish, tag, or push unless asked.
