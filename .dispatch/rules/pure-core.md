# Rule: pure core / imperative shell

Decision logic is pure (input → output), no I/O, no ambient state.
Effects (fs, db, shell, network, clock, random) are injected at the edges.
If a function reaches for a global/singleton instead of receiving it, refactor.
This is for testability, not purity dogma — stop where it would only add ceremony.
