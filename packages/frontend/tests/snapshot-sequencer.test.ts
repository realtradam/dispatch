import { describe, expect, it } from "vitest";
import { SnapshotSequencer } from "../src/lib/snapshot-sequencer.js";

describe("SnapshotSequencer", () => {
	it("accepts the first response unconditionally", () => {
		const s = new SnapshotSequencer();
		const seq = s.begin();
		expect(s.accept(seq)).toBe(true);
	});

	it("accepts responses in send order", () => {
		const s = new SnapshotSequencer();
		const a = s.begin();
		const b = s.begin();
		const c = s.begin();
		expect(s.accept(a)).toBe(true);
		expect(s.accept(b)).toBe(true);
		expect(s.accept(c)).toBe(true);
	});

	it("rejects an older response that arrives AFTER a newer one (the core race)", () => {
		// Sequence: user clicks hour 9 (A), then hour 10 (B). B arrives first.
		const s = new SnapshotSequencer();
		const a = s.begin(); // toggle hour 9
		const b = s.begin(); // toggle hour 10

		// B arrives first — applied.
		expect(s.accept(b)).toBe(true);

		// A arrives later — must be dropped, else the snapshot from B (which
		// knows about both 9 and 10) gets overwritten by A's stale snapshot
		// (which only knows about 9), and hour 10 vanishes from the UI.
		expect(s.accept(a)).toBe(false);
	});

	it("rejects ALL straggler responses once a newer one wins", () => {
		const s = new SnapshotSequencer();
		const a = s.begin();
		const b = s.begin();
		const c = s.begin();
		expect(s.accept(c)).toBe(true);
		expect(s.accept(b)).toBe(false);
		expect(s.accept(a)).toBe(false);
	});

	it("handles the initial-load vs first-click race", () => {
		// On mount: $effect fires loadFromServer (seq=1).
		// Before it lands, user clicks a hour (seq=2).
		const s = new SnapshotSequencer();
		const initial = s.begin();
		const click = s.begin();

		// Click response arrives first — applied.
		expect(s.accept(click)).toBe(true);
		// Initial load straggles in — must be dropped (it pre-dates the click).
		expect(s.accept(initial)).toBe(false);
	});

	it("treats an equal seq as accept (idempotent re-arrival of the winner)", () => {
		const s = new SnapshotSequencer();
		const a = s.begin();
		expect(s.accept(a)).toBe(true);
		// Defensive: same seq accepted again (shouldn't happen in practice
		// but the semantics must be 'no-op accept', not 'reject').
		expect(s.accept(a)).toBe(true);
	});

	it("seq numbers are monotonic and unique across begin() calls", () => {
		const s = new SnapshotSequencer();
		const seen = new Set<number>();
		let prev = 0;
		for (let i = 0; i < 100; i++) {
			const seq = s.begin();
			expect(seq).toBeGreaterThan(prev);
			expect(seen.has(seq)).toBe(false);
			seen.add(seq);
			prev = seq;
		}
	});

	it("state inspector reflects last-applied watermark", () => {
		const s = new SnapshotSequencer();
		expect(s.state).toEqual({ nextSeq: 0, latestApplied: 0 });
		const a = s.begin();
		const b = s.begin();
		s.accept(b);
		expect(s.state).toEqual({ nextSeq: 2, latestApplied: b });
		// A is too old now — accept() returns false and watermark doesn't move back.
		expect(s.accept(a)).toBe(false);
		expect(s.state.latestApplied).toBe(b);
	});
});
