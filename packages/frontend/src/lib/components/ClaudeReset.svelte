<script lang="ts">
import { onDestroy } from "svelte";
import { SnapshotSequencer } from "../snapshot-sequencer.js";

const { apiBase = "" }: { apiBase?: string } = $props();

/** Fixed offset (hours) from a wake to the "Claude session reset" display.
 *  Mirrors the backend constant — kept in sync via the GET response. */
const DEFAULT_RESET_OFFSET_HOURS = 5;
const DEFAULT_PROBE_SLOT_MINUTES = [0, 15, 30, 45] as const;

type ProbeMinute = number; // 0 | 15 | 30 | 45 in practice
type HourSlots = Record<ProbeMinute, number>; // slot minute → next fire ms

interface WakeResult {
	label: string;
	ok: boolean;
	error?: string;
}

interface LastWake {
	firedAt: number;
	ok: boolean;
	results: WakeResult[];
}

interface PendingRetry {
	retriesLeft: number;
	nextRetryAt: number;
	reason: string;
}

interface ScheduleSnapshot {
	/** hour (0-23) → { slotMinute → next fire ms }. */
	schedule: Record<string, Record<string, number>>;
	resetOffsetHours?: number;
	probeSlotMinutes?: number[];
	lastWake?: LastWake | null;
	pendingRetry?: PendingRetry | null;
}

// Marked hours: hour → { slotMinute → next fire ms }. Empty inner record = not marked.
let schedule = $state<Record<number, HourSlots>>({});
let resetOffsetHours = $state<number>(DEFAULT_RESET_OFFSET_HOURS);
let probeSlotMinutes = $state<readonly number[]>(DEFAULT_PROBE_SLOT_MINUTES);
let lastWake = $state<LastWake | null>(null);
let pendingRetry = $state<PendingRetry | null>(null);

/**
 * Global mutation lock: the hour whose toggle POST is currently in flight,
 * or null if none. Disables ALL toggle buttons (not just this hour's) while
 * any mutation is pending.
 *
 * Why global, not per-hour: snapshot responses can be reordered on the wire,
 * but worse, requests themselves can be reordered. If two POSTs are in
 * flight and the SERVER processes them out of order, the snapshot the
 * SnapshotSequencer picks as "winner" (highest client-send seq) may not be
 * the snapshot reflecting the truest server state — the UI desyncs from
 * the server permanently. Serializing mutations on the client eliminates
 * the reorder window entirely. (The sequencer is still useful for the
 * GET-on-mount vs first-click race.)
 */
let pendingHour = $state<number | null>(null);

/**
 * Single global sequencer for ALL /models/wake-schedule responses (initial
 * GET + every toggle POST). Each response is dropped if a newer request has
 * already won. This protects against three races:
 *   1. Two toggles on different hours land out of order — older snapshot
 *      blindly overwrites the newer one, and the most-recent click vanishes
 *      from the UI.
 *   2. The initial loadFromServer is still in flight when the user clicks.
 *   3. Any future fan-out (e.g. polling) racing a user action.
 * A per-hour counter was insufficient because applySnapshot replaces the
 * whole `schedule` object, not just one hour's slot. See snapshot-sequencer.ts.
 */
const sequencer = new SnapshotSequencer();

/** Live "now" used for the current-hour ring + relative timestamps. */
let nowMs = $state<number>(Date.now());

const nowTimer = setInterval(() => {
	nowMs = Date.now();
}, 30_000);

onDestroy(() => {
	clearInterval(nowTimer);
});

function formatHour(h: number): string {
	const display = h % 12;
	return display === 0 ? "12" : String(display);
}

/**
 * Compute the next occurrence of HH:MM in the user's local timezone.
 * Today if still future, else tomorrow.
 */
function nextOccurrenceAt(hour: number, minute: number): number {
	const target = new Date();
	target.setHours(hour, minute, 0, 0);
	if (target.getTime() <= Date.now()) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function applySnapshot(data: ScheduleSnapshot): void {
	const parsed: Record<number, HourSlots> = {};
	for (const [hourStr, slots] of Object.entries(data.schedule ?? {})) {
		const inner: HourSlots = {};
		for (const [slotStr, ts] of Object.entries(slots ?? {})) {
			inner[Number(slotStr)] = ts;
		}
		parsed[Number(hourStr)] = inner;
	}
	schedule = parsed;
	if (typeof data.resetOffsetHours === "number") {
		resetOffsetHours = data.resetOffsetHours;
	}
	if (Array.isArray(data.probeSlotMinutes) && data.probeSlotMinutes.length > 0) {
		probeSlotMinutes = data.probeSlotMinutes;
	}
	lastWake = data.lastWake ?? null;
	pendingRetry = data.pendingRetry ?? null;
}

async function loadFromServer(): Promise<void> {
	const mySeq = sequencer.begin();
	try {
		const res = await fetch(`${apiBase}/models/wake-schedule`);
		if (!res.ok) return;
		const data = (await res.json()) as ScheduleSnapshot;
		if (!sequencer.accept(mySeq)) return; // a newer response already won
		applySnapshot(data);
	} catch {
		// Network error — leave existing state
	}
}

function setPending(hour: number | null): void {
	pendingHour = hour;
}

async function postToggle(
	hour: number,
	action: "on" | "off",
	timestamps?: Record<number, number>,
): Promise<void> {
	const mySeq = sequencer.begin();
	setPending(hour);

	try {
		const body: {
			hour: number;
			action: "on" | "off";
			timestamps?: Record<string, number>;
		} = { hour, action };
		if (timestamps) {
			const stringKeyed: Record<string, number> = {};
			for (const [k, v] of Object.entries(timestamps)) stringKeyed[k] = v;
			body.timestamps = stringKeyed;
		}
		const res = await fetch(`${apiBase}/models/wake-schedule/toggle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) return;
		const data = (await res.json()) as ScheduleSnapshot;
		// Drop stale snapshots — only the most-recent request wins for ALL
		// shared state (schedule, lastWake, pendingRetry). Even with the
		// global mutation lock, this still catches the GET-on-mount vs
		// first-click race.
		if (!sequencer.accept(mySeq)) return;
		applySnapshot(data);
	} catch {
		// Network error — leave local state alone; user can re-toggle.
	} finally {
		setPending(null);
	}
}

function toggleHour(hour: number): void {
	// Global lock: any pending mutation on ANY hour blocks new clicks. This
	// serializes POSTs on the wire so the server never has to choose between
	// two concurrent requests — eliminating the request-reorder failure mode
	// where the sequencer's "highest client seq wins" rule would discard the
	// snapshot reflecting the true server state.
	if (pendingHour !== null) return;
	if (schedule[hour] !== undefined) {
		// User intent: turn this hour OFF.
		void postToggle(hour, "off");
	} else {
		// User intent: turn this hour ON — compute first occurrence of HH:MM
		// for each probe slot, in the user's local timezone.
		const timestamps: Record<number, number> = {};
		for (const minute of probeSlotMinutes) {
			timestamps[minute] = nextOccurrenceAt(hour, minute);
		}
		void postToggle(hour, "on", timestamps);
	}
}

$effect(() => {
	void loadFromServer();
});

/**
 * Faded hours: the `resetOffsetHours - 1` hours immediately after each
 * marked hour (the "active session window"). Excludes hours that are
 * themselves marked.
 */
const fadedHours = $derived.by((): Set<number> => {
	const result = new Set<number>();
	const window = Math.max(0, resetOffsetHours - 1);
	for (const h of Object.keys(schedule).map(Number)) {
		for (let i = 1; i <= window; i++) {
			const faded = (h + i) % 24;
			if (schedule[faded] === undefined) {
				result.add(faded);
			}
		}
	}
	return result;
});

const currentHour = $derived(new Date(nowMs).getHours());

function blockClass(hour: number, faded: Set<number>): string {
	const isMarked = schedule[hour] !== undefined;
	const isCurrent = hour === currentHour;
	const isFaded = faded.has(hour);
	// Only the hour whose request is in flight shows the "wait" cursor;
	// other buttons are merely disabled (via the template `disabled={...}`).
	const isPending = pendingHour === hour;

	let base =
		"flex items-center justify-center rounded select-none text-[10px] font-mono transition-colors";

	if (isPending) {
		base += " opacity-60 cursor-wait";
	} else {
		base += " cursor-pointer";
	}

	if (isMarked) {
		base += " bg-primary text-primary-content";
	} else if (isFaded) {
		base += " bg-primary/25 text-base-content";
	} else {
		base += " bg-base-300 text-base-content/60 hover:bg-base-content/10";
	}

	if (isCurrent) {
		base += " ring-2 ring-accent ring-offset-1 ring-offset-base-200";
	}

	return base;
}

function formatAmPm(hour24: number): string {
	const h = hour24 % 12;
	const ampm = hour24 < 12 ? "AM" : "PM";
	return `${h === 0 ? "12" : String(h)}:00 ${ampm}`;
}

function resetHour(wakeHour: number): number {
	return (wakeHour + resetOffsetHours) % 24;
}

function formatRelative(ts: number, now: number): string {
	const diff = now - ts;
	if (diff < 0) {
		const ahead = -diff;
		if (ahead < 60_000) return "in <1 min";
		if (ahead < 3600_000) return `in ${Math.round(ahead / 60_000)} min`;
		return `in ${Math.round(ahead / 3600_000)} h`;
	}
	if (diff < 60_000) return "just now";
	if (diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`;
	if (diff < 86_400_000) return `${Math.round(diff / 3600_000)} h ago`;
	return `${Math.round(diff / 86_400_000)} d ago`;
}

const markedHours = $derived(
	Object.keys(schedule)
		.map(Number)
		.sort((a, b) => a - b),
);

function probeLabel(minute: number): string {
	return `:${String(minute).padStart(2, "0")}`;
}

const probeLabels = $derived(probeSlotMinutes.map(probeLabel).join(" "));

const amRow1 = Array.from({ length: 6 }, (_, i) => i); // 0–5
const amRow2 = Array.from({ length: 6 }, (_, i) => i + 6); // 6–11
const pmRow1 = Array.from({ length: 6 }, (_, i) => i + 12); // 12–17
const pmRow2 = Array.from({ length: 6 }, (_, i) => i + 18); // 18–23
</script>

<div class="flex flex-col gap-2">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Claude Wake Schedule</div>

	<!-- AM rows -->
	<div class="flex items-center gap-1">
		<span class="text-[10px] font-semibold text-base-content/40 w-5 shrink-0">AM</span>
		<div class="flex flex-col gap-0.5">
			<div class="flex gap-0.5">
				{#each amRow1 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHour !== null} onclick={() => toggleHour(hour)} title="{formatHour(hour)} AM — probes at {probeLabels}">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each amRow2 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHour !== null} onclick={() => toggleHour(hour)} title="{formatHour(hour)} AM — probes at {probeLabels}">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<!-- PM rows -->
	<div class="flex items-center gap-1">
		<span class="text-[10px] font-semibold text-base-content/40 w-5 shrink-0">PM</span>
		<div class="flex flex-col gap-0.5">
			<div class="flex gap-0.5">
				{#each pmRow1 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHour !== null} onclick={() => toggleHour(hour)} title="{formatHour(hour)} PM — probes at {probeLabels}">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each pmRow2 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHour !== null} onclick={() => toggleHour(hour)} title="{formatHour(hour)} PM — probes at {probeLabels}">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<!-- Marked hours summary -->
	{#if markedHours.length > 0}
		<div class="flex flex-col gap-0.5 mt-1">
			{#each markedHours as hour}
				<div class="flex items-center gap-1.5 text-xs text-base-content/70">
					<span class="badge badge-xs badge-primary">{formatHour(hour)} {hour < 12 ? "AM" : "PM"}</span>
					<span>Probes {probeLabels} → reset by {formatAmPm(resetHour(hour))}</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-xs text-base-content/40 italic">No wake hours marked. Click a block to probe at {probeLabels} that hour.</p>
	{/if}

	<!-- Status: last wake / pending retry -->
	{#if lastWake}
		<div class="flex items-center gap-1.5 text-xs mt-1" class:text-success={lastWake.ok} class:text-error={!lastWake.ok}>
			<span class="font-semibold">{lastWake.ok ? "✓" : "✗"}</span>
			<span>Last wake {formatRelative(lastWake.firedAt, nowMs)}{lastWake.ok ? "" : ` — ${lastWake.results.find((r) => !r.ok)?.error ?? "failed"}`}</span>
		</div>
	{/if}
	{#if pendingRetry}
		<div class="text-xs text-warning">
			Retrying ({pendingRetry.retriesLeft} left, next {formatRelative(pendingRetry.nextRetryAt, nowMs)})
		</div>
	{/if}
</div>
