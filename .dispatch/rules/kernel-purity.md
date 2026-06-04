# Rule: kernel purity

The kernel touches NO I/O and names NO concrete feature.
Forbidden in `packages/kernel`: `node:fs`, `bun:sqlite`, `node:child_process`,
`fetch`/network, and any import of a concrete tool/provider/extension.
Need an effect? It belongs in an extension, injected through a contract.
