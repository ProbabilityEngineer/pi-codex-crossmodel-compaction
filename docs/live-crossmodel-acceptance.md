# Live cross-model compaction acceptance

## Result

**PASS — bounded manual acceptance test.**

The test used a fresh disposable Pi session, this checkout's extension, and the
user's existing authenticated Codex configuration. The user manually selected
each model in the same session. Sanitized temporary diagnostics were checked
against the persisted test state before recording this report.

## Observed sequence

| Stage | Result |
| --- | --- |
| Luna native checkpoint C1 | Created; ordinary Luna continuation succeeded |
| Luna → Sol | Exactly one transition compaction, requested using Luna |
| Sol checkpoint C2 | Fresh opaque checkpoint; locally bound to Sol |
| Sol consumption | Successful Sol provider responses carried C2 |
| Sol tool continuations | Three sequential tool/result cycles; zero additional transition compactions |
| Ordinary Sol continuation | Succeeded; no new transition |
| Sol → Luna | Exactly one transition compaction, requested using Sol |
| Luna checkpoint C3 | Fresh opaque checkpoint; locally bound to Luna |
| Luna consumption | Successful Luna provider responses carried C3 |
| Luna tool continuations | Two sequential tool/result cycles; zero additional transition compactions |

There were three native compaction requests total: initial C1 plus the two
model transitions. The transition identities were distinct, each used once.
The observed endpoint, account fingerprint, and authentication kind stayed
consistent. Diagnostics recorded no transition fallback, stop condition,
provider error, duplicated/lost current user, or malformed tool exchange.

## Validation after the live test

- Automated suite: **83/83 passed**
- Typecheck: passed
- `npm pack --dry-run`: passed
- `git diff --check`: passed

## Scope and limitations

This is evidence that the tested Luna → Sol → Luna sequence worked for this
session and account. It is not a general OpenAI protocol guarantee, nor evidence
for other model pairs, accounts, endpoints, or authentication modes. The test
was bounded and manually operated; no stress testing or failure-path live test
was performed.

No raw session, prompt, credential, header, opaque checkpoint content, account
fingerprint, or checkpoint hash is included in this report. Temporary observer
code and raw sanitized traces remain outside the repository and are not
required to interpret this summary.
