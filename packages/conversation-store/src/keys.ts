const SEQ_PAD = 10;

export function seqKey(conversationId: string): string {
	return `conv:${conversationId}:seq`;
}

export function msgKey(conversationId: string, seq: number): string {
	return `conv:${conversationId}:msg:${String(seq).padStart(SEQ_PAD, "0")}`;
}

export function msgPrefix(conversationId: string): string {
	return `conv:${conversationId}:msg:`;
}

export function parseSeq(raw: string | null): number {
	if (raw === null) return 0;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? 0 : n;
}

export function parseMsgSeq(key: string): number {
	const parts = key.split(":");
	const last = parts[parts.length - 1];
	if (last === undefined) return -1;
	const n = Number.parseInt(last, 10);
	return Number.isNaN(n) ? -1 : n;
}
