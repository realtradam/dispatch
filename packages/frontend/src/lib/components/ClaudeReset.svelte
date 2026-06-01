<script lang="ts">
import { onDestroy } from "svelte";

const { apiBase = "" }: { apiBase?: string } = $props();

/** Fixed offset (hours) from a wake to the "Claude session reset" display.
 *  Mirrors the backend constant — kept in sync via the GET response. */
const DEFAULT_RESET_OFFSET_HOURS = 5;

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
	schedule: Record<string, number>;
	resetOffsetHours?: number;
	lastWake?: LastWake | null;
	pendingRetry?: PendingRetry | null;
}

// Map of hour (0-23) → scheduled wake timestamp (ms)
let schedule = $state<Record<number, number>>({});
let resetOffsetHours = $state<number>(DEFAULT_RESET_OFFSET_HOURS);
let lastWake = $state<LastWake | null>(null);
let pendingRetry = $state<PendingRetry | null>(null);

/** Hours with an in-flight toggle request — disables their buttons. */
let pendingHours = $state<Set<number>>(new Set());

/**
 * Per-hour sequence numbers. Each toggle bumps the hour's counter; when a
 * response comes back we only apply it if it matches the latest counter,
 * so rapid double-clicks can't let an older response overwrite a newer one.
 */
const inFlightSeq: Record<number, number> = {};

/** Live "now" used for the current-hour ring. Bumped by an interval. */
let nowMs = $state<number>(Date.now());

// Re-derive current hour every minute (cheap; we don't need second-precision).
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

function nextOccurrenceAt15(hour: number): number {
	const now = new Date();
	const target = new Date(now);
	target.setHours(hour, 15, 0, 0);
	if (target.getTime() <= Date.now()) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function applySnapshot(data: ScheduleSnapshot): void {
	const parsed: Record<number, number> = {};
	for (const [k, v] of Object.entries(data.schedule ?? {})) {
		parsed[Number(k)] = v;
	}
	schedule = parsed;
	if (typeof data.resetOffsetHours === "number") {
		resetOffsetHours = data.resetOffsetHours;
	}
	lastWake = data.lastWake ?? null;
	pendingRetry = data.pendingRetry ?? null;
}

async function loadFromServer(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/wake-schedule`);
		if (!res.ok) return;
		const data = (await res.json()) as ScheduleSnapshot;
		applySnapshot(data);
	} catch {
		// Network error — leave existing state
	}
}

function markPending(hour: number, isPending: boolean): void {
	const next = new Set(pendingHours);
	if (isPending) next.add(hour);
	else next.delete(hour);
	pendingHours = next;
}

async function postToggle(hour: number, ts?: number): Promise<void> {
	// Bump the per-hour sequence; only the most-recent response wins.
	const mySeq = (inFlightSeq[hour] ?? 0) + 1;
	inFlightSeq[hour] = mySeq;
	markPending(hour, true);

	try {
		const body: { hour: number; timestamp?: number } = { hour };
		if (typeof ts === "number") body.timestamp = ts;
		const res = await fetch(`${apiBase}/models/wake-schedule/toggle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		// Drop stale responses (newer click in flight or completed).
		if (inFlightSeq[hour] !== mySeq) return;
		if (!res.ok) return;
		const data = (await res.json()) as ScheduleSnapshot;
		applySnapshot(data);
	} catch {
		// Network error — leave local state alone; user can re-toggle.
	} finally {
		if (inFlightSeq[hour] === mySeq) {
			markPending(hour, false);
		}
	}
}

function toggleHour(hour: number): void {
	if (pendingHours.has(hour)) return;
	if (schedule[hour] !== undefined) {
		// Toggle off
		void postToggle(hour);
	} else {
		// Toggle on
		void postToggle(hour, nextOccurrenceAt15(hour));
	}
}

$effect(() => {
	void loadFromServer();
});

/**
 * Faded hours: the `resetOffsetHours - 1` hours immediately after each
 * scheduled wake (the "active session window"). Excludes hours that have
 * their own scheduled wake. Stored as a real Set, not a getter — the old
 * code accidentally wrapped this in a function and called it 24× per render.
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
	const isScheduled = schedule[hour] !== undefined;
	const isCurrent = hour === currentHour;
	const isFaded = faded.has(hour);
	const isPending = pendingHours.has(hour);

	let base =
		"flex items-center justify-center rounded select-none text-[10px] font-mono transition-colors";

	if (isPending) {
		base += " opacity-60 cursor-wait";
	} else {
		base += " cursor-pointer";
	}

	if (isScheduled) {
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

const scheduledHours = $derived(
	Object.keys(schedule)
		.map(Number)
		.sort((a, b) => (schedule[a] ?? 0) - (schedule[b] ?? 0)),
);

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
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHours.has(hour)} onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 AM">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each amRow2 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHours.has(hour)} onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 AM">
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
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHours.has(hour)} onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 PM">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each pmRow2 as hour}
					<button type="button" class="{blockClass(hour, fadedHours)} w-[22px] h-[24px]" disabled={pendingHours.has(hour)} onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 PM">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<!-- Scheduled summary -->
	{#if scheduledHours.length > 0}
		<div class="flex flex-col gap-0.5 mt-1">
			{#each scheduledHours as hour}
				<div class="flex items-center gap-1.5 text-xs text-base-content/70">
					<span class="badge badge-xs badge-primary">{formatHour(hour)}:15</span>
					<span>Reset at {formatAmPm(resetHour(hour))}</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-xs text-base-content/40 italic">No wake times scheduled. Click a block to schedule.</p>
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
