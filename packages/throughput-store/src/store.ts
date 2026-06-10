import type { Logger, StorageNamespace } from "@dispatch/kernel";
import { aggregateSamples, type ModelThroughput, type ThroughputSample } from "./aggregate.js";
import { dayKeyOf, type Period, resolvePeriod } from "./period.js";

export interface ThroughputReport {
	readonly period: Period;
	readonly date: string;
	/** Inclusive start, epoch-ms. */
	readonly start: number;
	/** Exclusive end, epoch-ms. */
	readonly end: number;
	readonly models: readonly ModelThroughput[];
}

export interface ThroughputQuery {
	readonly period: Period;
	readonly date: string;
}

/**
 * Cross-conversation, per-model throughput store. Records one sample per
 * completed turn and aggregates token-weighted tok/s over a day/week/month.
 * Persistence is the injected KV namespace; samples are bucketed by local day
 * key so a period query addresses only its own day buckets.
 */
export interface ThroughputStore {
	readonly record: (sample: ThroughputSample) => Promise<void>;
	readonly aggregate: (query: ThroughputQuery) => Promise<ThroughputReport>;
}

export interface ThroughputStoreDeps {
	readonly storage: StorageNamespace;
	readonly logger?: Logger;
	/** Injectable unique-id generator (default crypto.randomUUID). */
	readonly newId?: () => string;
}

/** Thrown when a query's `(period, date)` is malformed. */
export class ThroughputQueryError extends Error {}

const SAMPLE_PREFIX = "sample";

export function createThroughputStore(deps: ThroughputStoreDeps): ThroughputStore {
	const newId = deps.newId ?? (() => crypto.randomUUID());

	return {
		async record(sample) {
			// Per-sample key under the local-day bucket → write is a single set
			// (no read-modify-write, so concurrent turns can't lose a sample).
			const day = dayKeyOf(sample.ts);
			const key = `${SAMPLE_PREFIX}:${day}:${sample.ts}:${newId()}`;
			await deps.storage.set(key, JSON.stringify(sample));
		},

		async aggregate(query) {
			const resolved = resolvePeriod(query.period, query.date);
			if (!resolved.ok) throw new ThroughputQueryError(resolved.error);

			const samples: ThroughputSample[] = [];
			for (const day of resolved.dayKeys) {
				const keys = await deps.storage.keys(`${SAMPLE_PREFIX}:${day}:`);
				for (const k of keys) {
					const raw = await deps.storage.get(k);
					if (raw === null) continue;
					try {
						samples.push(JSON.parse(raw) as ThroughputSample);
					} catch {
						// Skip a malformed row rather than failing the whole query.
					}
				}
			}

			const models = aggregateSamples(samples, resolved.start, resolved.end);
			return {
				period: query.period,
				date: resolved.date,
				start: resolved.start,
				end: resolved.end,
				models,
			};
		},
	};
}
