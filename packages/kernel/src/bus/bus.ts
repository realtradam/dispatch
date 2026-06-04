import type { Logger } from "../contracts/extension.js";
import type {
	EventHandler,
	EventHookDescriptor,
	FilterDescriptor,
	FilterHandler,
	ServiceHandle,
} from "../contracts/hooks.js";
import {
	applyFilterChain,
	dispatchEventAsync,
	dispatchEventSync,
	type FilterEntry,
	sortFilters,
} from "./pure.js";

export interface Bus {
	readonly on: <T>(hook: EventHookDescriptor<T>, handler: EventHandler<T>) => () => void;
	readonly emit: <T>(hook: EventHookDescriptor<T>, payload: T) => void;
	readonly emitAsync: <T>(
		hook: EventHookDescriptor<T>,
		payload: T,
		timeoutMs?: number,
	) => Promise<void>;
	readonly addFilter: <T>(
		hook: FilterDescriptor<T>,
		fn: FilterHandler<T>,
		opts?: { readonly priority?: number },
	) => () => void;
	readonly applyFilters: <T>(
		hook: FilterDescriptor<T>,
		value: T,
		opts?: { readonly failClosed?: boolean },
	) => Promise<T>;
	readonly provideService: <T>(handle: ServiceHandle<T>, impl: T) => void;
	readonly getService: <T>(handle: ServiceHandle<T>) => T;
}

interface StoredFilterEntry {
	readonly fn: unknown;
	readonly priority: number;
	readonly order: number;
}

export function createBus(logger: Logger): Bus {
	const eventHandlers = new Map<string, Set<unknown>>();
	const filterEntries = new Map<string, StoredFilterEntry[]>();
	const services = new Map<string, unknown>();
	let filterOrderCounter = 0;

	return {
		on<T>(hook: EventHookDescriptor<T>, handler: EventHandler<T>): () => void {
			let set = eventHandlers.get(hook.id);
			if (set === undefined) {
				set = new Set();
				eventHandlers.set(hook.id, set);
			}
			const stored: unknown = handler;
			set.add(stored);
			return () => {
				const current = eventHandlers.get(hook.id);
				if (current !== undefined) current.delete(stored);
			};
		},

		emit<T>(hook: EventHookDescriptor<T>, payload: T): void {
			const set = eventHandlers.get(hook.id);
			if (set === undefined || set.size === 0) return;
			const handlers = [...set] as Array<EventHandler<T>>;
			dispatchEventSync(handlers, payload, logger, hook.id);
		},

		async emitAsync<T>(
			hook: EventHookDescriptor<T>,
			payload: T,
			timeoutMs?: number,
		): Promise<void> {
			const set = eventHandlers.get(hook.id);
			if (set === undefined || set.size === 0) return;
			const handlers = [...set] as Array<EventHandler<T>>;
			await dispatchEventAsync(handlers, payload, logger, hook.id, timeoutMs);
		},

		addFilter<T>(
			hook: FilterDescriptor<T>,
			fn: FilterHandler<T>,
			opts?: { readonly priority?: number },
		): () => void {
			let entries = filterEntries.get(hook.id);
			if (entries === undefined) {
				entries = [];
				filterEntries.set(hook.id, entries);
			}
			const entry: StoredFilterEntry = {
				fn,
				priority: opts?.priority ?? 0,
				order: filterOrderCounter++,
			};
			entries.push(entry);
			return () => {
				const current = filterEntries.get(hook.id);
				if (current === undefined) return;
				const idx = current.indexOf(entry);
				if (idx !== -1) current.splice(idx, 1);
			};
		},

		async applyFilters<T>(
			hook: FilterDescriptor<T>,
			value: T,
			opts?: { readonly failClosed?: boolean },
		): Promise<T> {
			const entries = filterEntries.get(hook.id);
			if (entries === undefined || entries.length === 0) return value;
			const sorted = sortFilters(entries as ReadonlyArray<FilterEntry<T>>);
			const fns = sorted.map((e) => e.fn) as Array<FilterHandler<T>>;
			return applyFilterChain(fns, value, logger, hook.id, opts?.failClosed ?? false);
		},

		provideService<T>(handle: ServiceHandle<T>, impl: T): void {
			if (services.has(handle.id)) {
				throw new Error(
					`Service "${handle.id}" is already provided. Only one provider per handle is allowed.`,
				);
			}
			services.set(handle.id, impl);
		},

		getService<T>(handle: ServiceHandle<T>): T {
			const impl = services.get(handle.id);
			if (impl === undefined) {
				throw new Error(
					`Service "${handle.id}" has no provider. Call provideService before getService.`,
				);
			}
			return impl as T;
		},
	};
}
