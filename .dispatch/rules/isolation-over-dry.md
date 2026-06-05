# Rule: isolation over DRY

Prefer self-contained, even DUPLICATED, code in each extension over a shared helper
that two+ extensions import. A shared module wired between sibling features is a
coupling smell — it breaks feature-as-a-library (P1) and ties their fates together.
Get consistency by sharing KNOWLEDGE in the harness (`.dispatch/rules`, skills,
`GLOSSARY.md`), never shared runtime code.
The ONLY sanctioned shared surfaces are the kernel ABI (host-provided, injected) and
typed contracts — NOT a new utility module between features.
When tempted to "extract a helper for consistency," stop: that is reputation-driven
DRY (P4). Duplicating a small function across the few features that need it is the
intended trade.
