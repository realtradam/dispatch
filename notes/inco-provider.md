# Inco provider

## Official identity and verified API

- [Official API reference](https://platform.inco.ai/docs): “https://api.inco.ai/v1”.
- Authentication: “Send your `sk-inco-…` key as a bearer token”.
- Catalog: “GET /v1/models lists every model with its context length and prices.”
- Streaming: “Every endpoint streams with server-sent events when you pass `stream: true`.”
- Reasoning is `reasoning_effort` in Chat Completions; unsupported maker effort
  values are refused with HTTP 400 rather than silently ignored.

The provider identity was established from official documentation, independently
of any inference from the supplied key. Public and authenticated catalog probes
both returned HTTP 200 on 2026-10-23. The authenticated catalog included standard
and `:fast` variants of GLM 5.3 Flash, DeepSeek V4.1 Flash, Kimi K3, GLM 5.3,
and MiniMax M3, plus MiniMax M3.1 Flash.

User specifically referenced `glm-5.3-flash:fast`; it is the default. Standard and
fast catalog IDs remain distinct, without rewriting explicit user choices.

## Activation and credential safety

Real credentials belong in injected process environment or `/etc/dispatch/env`,
not tracked configuration, reports, commands or source. `bin/set-inco-key` is a
reviewable, user-run privileged helper. See its `--help` and README for setup.
The helper must never restart shared services. Building and installing this
branch, then an operator-approved restart and workspace enablement, are separate
activation steps.

Live validation uses the provider's public API against the official endpoint,
with the staged credential read locally and never printed. No shared service
or data store is modified to test inference. Tests and live-probe results are
recorded in the task report; credentials and raw authorization headers are not.
