# Rule: extension logging + self-redaction

Use the injected `host.logger` (and the `ctx.log` / span you're handed) — never
`console.*`, never a hand-rolled logger, never your own correlation ids. `extensionId`
is auto-stamped by the host: do NOT set it or invent an id scheme.

- **Self-redact your OWN secrets, in your OWN code, at the log call-site.** There is no
  shared `redact()` and nothing in the kernel does it for you — you alone know what is
  secret and how to censor it (isolation over DRY). Mask BEFORE the record is built so a
  raw secret never reaches the sink/journal.
- **Redaction = partial mask, keep the field present + diffable** (never drop it): reveal
  first+last real chars with a fixed-width `…redacted…` middle, graduated by length —
  `≥13`→reveal 3 each side · `11–12`→2 · `8–10`→1 · `≤7`→full mask. Reimplement this
  locally per extension; declare your own secret fields/headers (e.g. the `authorization`
  header + any vault-injected body field).
- **Edge I/O (providers/transports): capture verbatim, post-transform, at the fetch edge**
  (the bytes that hit the wire = ground truth), self-redacting secret headers/fields. Put
  large verbatim payloads in the span `body`, not in attributes.
- **Attributes are flat scalars** (string/number/boolean/null) — nest → stringify. Spans:
  open at the work's start, `end()` at its finish, so a crashed turn is reconstructable.
- **Do NOT log token deltas / per-chunk streaming** — high-frequency and redundant (the
  chunk log already has the final text).
- **Logs are one-way**: never read another extension's logs; cross-feature reaction is a
  hook/service, not a log. Logging never blocks or fails a turn — emit and move on.
