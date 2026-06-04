# Rule: typed handles, no string-keyed coupling

Every cross-extension coupling is anchored to an exported TYPED symbol:
hook descriptors (`defineHook<T>(...)`) and service handles, never a raw string
at the consumer site. A string-keyed cross-feature lookup must be a compile
error, so `lsp references` on the symbol returns the true blast radius.
Exception: the kernel routing a tool-call by name (that's data, not a code ref).
