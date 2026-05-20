<script lang="ts">
	const { apiBase = "" }: { apiBase?: string } = $props();

	// Map of hour (0-23) → scheduled wake timestamp (ms)
	let schedule = $state<Record<number, number>>({});

	// Active timeout IDs keyed by hour
	const timeoutIds: Record<number, ReturnType<typeof setTimeout>> = {};

	function formatHour(h: number): string {
		const display = h % 12;
		return display === 0 ? "12" : String(display);
	}

	function loadSchedule(): Record<number, number> {
		try {
			const raw = localStorage.getItem("claude-reset-schedule");
			if (!raw) return {};
			return JSON.parse(raw) as Record<number, number>;
		} catch {
			return {};
		}
	}

	function saveSchedule(s: Record<number, number>): void {
		try {
			localStorage.setItem("claude-reset-schedule", JSON.stringify(s));
		} catch {
			// localStorage unavailable — ignore
		}
	}

	async function triggerWake(hour: number): Promise<void> {
		try {
			await fetch(`${apiBase}/models/wake`, { method: "POST" });
		} catch {
			// Ignore network errors
		}
		// Remove this hour from the schedule
		const updated = { ...schedule };
		delete updated[hour];
		schedule = updated;
		saveSchedule(schedule);
	}

	function scheduleTimeout(hour: number, ts: number): void {
		const delay = ts - Date.now();
		if (delay <= 0) {
			// Already past — fire immediately
			void triggerWake(hour);
			return;
		}
		const id = setTimeout(() => {
			void triggerWake(hour);
		}, delay);
		timeoutIds[hour] = id;
	}

	function clearHourTimeout(hour: number): void {
		if (timeoutIds[hour] !== undefined) {
			clearTimeout(timeoutIds[hour]);
			delete timeoutIds[hour];
		}
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

	function toggleHour(hour: number): void {
		if (schedule[hour] !== undefined) {
			// Deschedule
			clearHourTimeout(hour);
			const updated = { ...schedule };
			delete updated[hour];
			schedule = updated;
			saveSchedule(schedule);
		} else {
			// Schedule
			const ts = nextOccurrenceAt15(hour);
			schedule = { ...schedule, [hour]: ts };
			saveSchedule(schedule);
			scheduleTimeout(hour, ts);
		}
	}

	$effect(() => {
		// Load persisted schedule on mount
		const loaded = loadSchedule();
		const now = Date.now();
		const cleaned: Record<number, number> = {};

		for (const [k, ts] of Object.entries(loaded)) {
			const hour = Number(k);
			if (ts >= now) {
				cleaned[hour] = ts;
			}
		}

		schedule = cleaned;
		saveSchedule(cleaned);

		// Register timeouts for all future entries
		for (const [k, ts] of Object.entries(cleaned)) {
			scheduleTimeout(Number(k), ts);
		}

		// Cleanup on destroy
		return () => {
			for (const id of Object.values(timeoutIds)) {
				clearTimeout(id);
			}
		};
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

		let base = "flex items-center justify-center rounded cursor-pointer select-none text-[10px] font-mono transition-colors";

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

	function formatWakeTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	const scheduledHours = $derived(
		Object.keys(schedule)
			.map(Number)
			.sort((a, b) => (schedule[a] ?? 0) - (schedule[b] ?? 0))
	);

	const amRow1 = Array.from({ length: 6 }, (_, i) => i);       // 0–5
	const amRow2 = Array.from({ length: 6 }, (_, i) => i + 6);   // 6–11
	const pmRow1 = Array.from({ length: 6 }, (_, i) => i + 12);  // 12–17
	const pmRow2 = Array.from({ length: 6 }, (_, i) => i + 18);  // 18–23
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
					<span>Wake scheduled for {formatWakeTime(schedule[hour] ?? 0)}</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-xs text-base-content/40 italic">No wake times scheduled. Click a block to schedule.</p>
	{/if}
</div>
