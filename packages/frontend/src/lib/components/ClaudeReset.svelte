<script lang="ts">
const { apiBase = "" }: { apiBase?: string } = $props();

// Map of hour (0-23) → scheduled wake timestamp (ms)
let schedule = $state<Record<number, number>>({});

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

async function loadFromServer(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/wake-schedule`);
		if (!res.ok) return;
		const data = (await res.json()) as { schedule: Record<string, number> };
		const parsed: Record<number, number> = {};
		for (const [k, v] of Object.entries(data.schedule)) {
			parsed[Number(k)] = v;
		}
		schedule = parsed;
	} catch {
		// Network error — leave schedule empty
	}
}

async function parseScheduleResponse(res: Response): Promise<void> {
	const data = (await res.json()) as { schedule: Record<string, number> };
	const parsed: Record<number, number> = {};
	for (const [k, v] of Object.entries(data.schedule)) {
		parsed[Number(k)] = v;
	}
	schedule = parsed;
}

async function toggleOnServer(hour: number, ts: number): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/wake-schedule/toggle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hour, timestamp: ts }),
		});
		if (!res.ok) return;
		await parseScheduleResponse(res);
	} catch {
		// Network error — keep local state
	}
}

async function removeFromServer(hour: number): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/wake-schedule/toggle`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hour }),
		});
		if (!res.ok) return;
		await parseScheduleResponse(res);
	} catch {
		// Network error — keep local state
	}
}

function toggleHour(hour: number): void {
	if (schedule[hour] !== undefined) {
		void removeFromServer(hour);
	} else {
		const ts = nextOccurrenceAt15(hour);
		void toggleOnServer(hour, ts);
	}
}

$effect(() => {
	void loadFromServer();
});

// Compute "faded" hours: the 4 hours after each scheduled block
const fadedHours = $derived((): Set<number> => {
	const result = new Set<number>();
	for (const h of Object.keys(schedule).map(Number)) {
		for (let i = 1; i <= 4; i++) {
			const faded = (h + i) % 24;
			if (schedule[faded] === undefined) {
				result.add(faded);
			}
		}
	}
	return result;
});

const currentHour = $derived(new Date().getHours());

function blockClass(hour: number): string {
	const isScheduled = schedule[hour] !== undefined;
	const isCurrent = hour === currentHour;
	const isFaded = fadedHours().has(hour);

	let base =
		"flex items-center justify-center rounded cursor-pointer select-none text-[10px] font-mono transition-colors";

	if (isScheduled) {
		base += " bg-primary text-primary-content";
	} else if (isFaded) {
		base += " bg-primary/25 text-base-content";
	} else {
		base += " bg-base-300 text-base-content/60 hover:bg-base-content/10";
	}

	if (isCurrent) {
		if (isScheduled) {
			base += " ring-2 ring-accent ring-offset-1 ring-offset-base-200";
		} else {
			base += " ring-2 ring-accent ring-offset-1 ring-offset-base-200";
		}
	}

	return base;
}

function formatAmPm(hour24: number): string {
	const h = hour24 % 12;
	const ampm = hour24 < 12 ? "AM" : "PM";
	return `${h === 0 ? "12" : String(h)}:00 ${ampm}`;
}

function resetHour(wakeHour: number): number {
	return (wakeHour + 5) % 24;
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
					<button type="button" class="{blockClass(hour)} w-[22px] h-[24px]" onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 AM">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each amRow2 as hour}
					<button type="button" class="{blockClass(hour)} w-[22px] h-[24px]" onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 AM">
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
					<button type="button" class="{blockClass(hour)} w-[22px] h-[24px]" onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 PM">
						{formatHour(hour)}
					</button>
				{/each}
			</div>
			<div class="flex gap-0.5">
				{#each pmRow2 as hour}
					<button type="button" class="{blockClass(hour)} w-[22px] h-[24px]" onclick={() => toggleHour(hour)} title="{formatHour(hour)}:15 PM">
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
</div>
