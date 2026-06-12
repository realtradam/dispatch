const SEQ_PAD = 10;

export function seqKey(conversationId: string): string {
	return `conv:${conversationId}:seq`;
}

export function chunkKey(conversationId: string, seq: number): string {
	return `conv:${conversationId}:chunk:${String(seq).padStart(SEQ_PAD, "0")}`;
}

export function chunkPrefix(conversationId: string): string {
	return `conv:${conversationId}:chunk:`;
}

export function parseSeq(raw: string | null): number {
	if (raw === null) return 0;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? 0 : n;
}

export function parseChunkSeq(key: string): number {
	const parts = key.split(":");
	const last = parts[parts.length - 1];
	if (last === undefined) return -1;
	const n = Number.parseInt(last, 10);
	return Number.isNaN(n) ? -1 : n;
}

export function metricsSeqKey(conversationId: string): string {
	return `conv:${conversationId}:metrics-seq`;
}

export function metricsKey(conversationId: string, ordinal: number): string {
	return `conv:${conversationId}:metrics:${String(ordinal).padStart(SEQ_PAD, "0")}`;
}

export function metricsPrefix(conversationId: string): string {
	return `conv:${conversationId}:metrics:`;
}

export function parseMetricsOrdinal(key: string): number {
	const parts = key.split(":");
	const last = parts[parts.length - 1];
	if (last === undefined) return -1;
	const n = Number.parseInt(last, 10);
	return Number.isNaN(n) ? -1 : n;
}

export function cwdKey(conversationId: string): string {
	return `conv:${conversationId}:cwd`;
}

export function reasoningEffortKey(conversationId: string): string {
	return `conv:${conversationId}:reasoning-effort`;
}
