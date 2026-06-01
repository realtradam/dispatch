/**
 * Tiny race guard for "the most-recent request wins" semantics.
 *
 * When a frontend component fans out multiple HTTP calls that each return a
 * full snapshot of shared state — and applying an older snapshot would clobber
 * a newer one — wrap each call with `seq = sequencer.begin()` before send and
 * `sequencer.accept(seq)` before applying the response. Older sequences are
 * rejected.
 *
 * Why: the Claude Wake Schedule's POST /toggle and GET /wake-schedule both
 * return the *whole* schedule. If a user toggles hour 9 (request A) and then
 * hour 10 (request B), and B's response arrives before A's, the older A
 * response — which doesn't know about hour 10 yet — would otherwise overwrite
 * hour 10 right out of the UI. A per-hour counter is NOT enough because the
 * race spans different hours (and also covers the initial-load vs first-click
 * race).
 *
 * `>=` on accept is intentional: if seq equals the latest applied seq, the
 * response is a redundant arrival of the most-recent winner — accepting it
 * (idempotently) is fine. The discriminator is *strictly less than*.
 */
export class SnapshotSequencer {
	private nextSeq = 0;
	private latestApplied = 0;

	/** Tag a new request. Call before sending; pass the returned seq to accept(). */
	begin(): number {
		this.nextSeq += 1;
		return this.nextSeq;
	}

	/**
	 * Decide whether to apply a response. Returns true if this seq is the
	 * newest seen so far (and updates the watermark); false if a newer
	 * response has already won.
	 */
	accept(seq: number): boolean {
		if (seq < this.latestApplied) return false;
		this.latestApplied = seq;
		return true;
	}

	/** Inspect (for tests / debugging). */
	get state(): { nextSeq: number; latestApplied: number } {
		return { nextSeq: this.nextSeq, latestApplied: this.latestApplied };
	}
}
