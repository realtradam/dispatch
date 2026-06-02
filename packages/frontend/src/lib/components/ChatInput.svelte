<script lang="ts">
import {
	ACCEPTED_PDF_MEDIA_TYPE,
	isImageMediaType,
	isPdfMediaType,
	MAX_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_PDF_BYTES,
} from "@dispatch/core/src/models/attachments.js";
import {
	type AttachmentKind,
	computeTokenDeletion,
	generateTokenId,
	makeAttachmentToken,
	parseDraft,
	type StagedAttachment,
} from "../attachment-tokens.js";
import { computeContextUsage } from "../context-window.js";
import { tabStore } from "../tabs.svelte.js";

const {
	contextLimit = null,
	imageSupport = null,
}: {
	contextLimit?: number | null;
	// Image/PDF INPUT capability for the active model, or `null` when unknown
	// (catalog offline / unsupported provider) — null means "can't verify"
	// (optimistic allow), not a hard no.
	imageSupport?: { image: boolean; pdf: boolean } | null;
} = $props();

const MAX_LINES = 7;

let inputEl: HTMLTextAreaElement | undefined;
// Transient error shown when a paste is rejected (bad type / too large / too
// many). Cleared on the next successful paste or any keystroke.
let pasteError = $state<string | null>(null);

const agentStatus = $derived(tabStore.activeTab?.agentStatus ?? "idle");
const tabId = $derived(tabStore.activeTab?.id ?? "");
// The current input text lives on the active tab (in-memory draft), so
// switching tabs saves the current draft and restores the target tab's text
// automatically — drafts are never lost or clobbered by tab switching.
const inputValue = $derived(tabStore.activeTab?.draft ?? "");
const attachments = $derived(tabStore.activeTab?.attachments ?? []);
const cacheStats = $derived(tabStore.activeTab?.cacheStats ?? null);

const isRunning = $derived(agentStatus === "running");
const hasText = $derived(inputValue.trim().length > 0);
const hasAttachments = $derived(attachments.length > 0);
// While generating with an empty box, the primary action is "stop". With text
// in the box, it stays "send" (the message is queued behind the live turn).
const showStop = $derived(isRunning && !hasText && !hasAttachments);

// ─── Attachment capability gating ──────────────────────────────
// A definitive "no" from the catalog (imageSupport.image === false with an
// image staged, or .pdf === false with a pdf staged) blocks the send so no
// tokens are spent. Unknown capability (imageSupport === null) is permissive.
const hasImageAttachment = $derived(attachments.some((a) => a.kind === "image"));
const hasPdfAttachment = $derived(attachments.some((a) => a.kind === "pdf"));
const imageBlocked = $derived(
	hasImageAttachment && imageSupport !== null && imageSupport.image === false,
);
const pdfBlocked = $derived(
	hasPdfAttachment && imageSupport !== null && imageSupport.pdf === false,
);
// Attachments require a fresh turn — they can't ride the queue path (which is
// text-only), so block sending an attachment while the agent is generating.
const attachmentsWhileRunning = $derived(hasAttachments && isRunning);

const attachmentWarning = $derived.by(() => {
	if (pasteError) return pasteError;
	if (attachmentsWhileRunning)
		return "Wait for the current response to finish before sending images.";
	if (imageBlocked && pdfBlocked)
		return "The selected model doesn't support image or PDF input. Remove the attachments to send.";
	if (imageBlocked)
		return "The selected model doesn't support image input. Remove the image to send.";
	if (pdfBlocked) return "The selected model doesn't support PDF input. Remove the PDF to send.";
	return null;
});

// Send is blocked (but not the box) when an attachment is definitively
// unsupported or when attachments are staged mid-generation.
const sendBlocked = $derived(imageBlocked || pdfBlocked || attachmentsWhileRunning);

const usage = $derived(computeContextUsage(cacheStats, contextLimit));
const hasUsage = $derived((cacheStats?.last ?? null) !== null);

// As the window fills, escalate color: calm → warning → danger. Mirrors the
// Context Window sidebar view so the two displays agree.
function fillClass(pct: number): string {
	if (pct >= 90) return "progress-error";
	if (pct >= 70) return "progress-warning";
	return "progress-success";
}

// Compact token count for the slim bar (e.g. 12.3k, 1.2M). Full numbers live
// in the sidebar's Context Window panel.
function fmtCompact(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

$effect(() => {
	// Re-focus when switching tabs.
	void tabId;
	inputEl?.focus();
});

function resize() {
	const el = inputEl;
	if (!el) return;
	// Reset height so scrollHeight reflects the content's natural height.
	el.style.height = "auto";
	const style = getComputedStyle(el);
	const lineHeight = Number.parseFloat(style.lineHeight) || 20;
	const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
	const borderY =
		Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
	const maxHeight = lineHeight * MAX_LINES + paddingY + borderY;
	const next = Math.min(el.scrollHeight, maxHeight);
	el.style.height = `${next}px`;
	el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Re-run resize whenever the value changes (covers tab switches and
// programmatic clears too).
$effect(() => {
	// Touch inputValue so this effect tracks it.
	void inputValue;
	resize();
});

function handleInput(e: Event) {
	if (!tabId) return;
	pasteError = null;
	// setDraft also reconciles staged attachments against the surviving tokens,
	// so deleting a token (by any means) detaches its attachment.
	tabStore.setDraft(tabId, (e.currentTarget as HTMLTextAreaElement).value);
}

function kindForMediaType(mediaType: string): AttachmentKind | null {
	if (isImageMediaType(mediaType)) return "image";
	if (isPdfMediaType(mediaType)) return "pdf";
	return null;
}

function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("unexpected reader result"));
				return;
			}
			// Strip the `data:<mediaType>;base64,` prefix → bare base64.
			const comma = result.indexOf(",");
			resolve(comma === -1 ? result : result.slice(comma + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(file);
	});
}

/** Insert `insert` at the textarea's caret, returning the new caret offset. */
function insertAtCaret(insert: string): number {
	const el = inputEl;
	const text = inputValue;
	const start = el?.selectionStart ?? text.length;
	const end = el?.selectionEnd ?? text.length;
	const next = text.slice(0, start) + insert + text.slice(end);
	if (tabId) tabStore.setDraft(tabId, next);
	return start + insert.length;
}

async function handlePaste(e: ClipboardEvent) {
	if (!tabId) return;
	const items = e.clipboardData?.items;
	if (!items) return;
	const files: File[] = [];
	for (const item of items) {
		if (item.kind === "file") {
			const file = item.getAsFile();
			if (file) files.push(file);
		}
	}
	// No files in the clipboard → let the default text paste happen.
	if (files.length === 0) return;
	// We're handling at least one file; stop the browser from also pasting a
	// filename / image fallback into the textarea.
	e.preventDefault();
	pasteError = null;

	for (const file of files) {
		const kind = kindForMediaType(file.type);
		if (!kind) {
			pasteError = `Unsupported file type: ${file.type || "unknown"}. Allowed: PNG, JPEG, WebP, GIF, PDF.`;
			continue;
		}
		const current = tabStore.activeTab?.attachments ?? [];
		if (current.length >= MAX_ATTACHMENTS) {
			pasteError = `You can attach at most ${MAX_ATTACHMENTS} files per message.`;
			break;
		}
		const limit = kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
		if (file.size > limit) {
			const mb = Math.round(limit / (1024 * 1024));
			pasteError = `${kind === "pdf" ? "PDF" : "Image"} is too large (max ${mb} MB).`;
			continue;
		}
		try {
			const data = await readAsBase64(file);
			const id = generateTokenId();
			const mediaType = kind === "pdf" ? ACCEPTED_PDF_MEDIA_TYPE : file.type;
			const staged: StagedAttachment = {
				id,
				kind,
				mediaType,
				data,
				...(file.name ? { name: file.name } : {}),
			};
			// Stage first, then insert the token — `setDraft` reconciles against
			// staged attachments, so the attachment must exist before its token
			// appears in the draft.
			tabStore.addAttachment(tabId, staged);
			const caret = insertAtCaret(makeAttachmentToken(kind, id));
			// Restore the caret after the value updates.
			requestAnimationFrame(() => {
				const el = inputEl;
				if (el) {
					el.focus();
					el.setSelectionRange(caret, caret);
				}
			});
		} catch {
			pasteError = "Failed to read the pasted file.";
		}
	}
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
		return;
	}
	if ((e.key === "Backspace" || e.key === "Delete") && inputEl && tabId) {
		// Atomic token delete: a single Backspace/Delete next to (or a selection
		// overlapping) a `【…】` token removes the whole token in one stroke.
		const result = computeTokenDeletion(
			inputValue,
			inputEl.selectionStart ?? 0,
			inputEl.selectionEnd ?? 0,
			e.key,
		);
		if (result) {
			e.preventDefault();
			tabStore.setDraft(tabId, result.text);
			requestAnimationFrame(() => {
				const el = inputEl;
				if (el) {
					el.focus();
					el.setSelectionRange(result.caret, result.caret);
				}
			});
		}
	}
}

function submit() {
	if (!tabId) return;
	const map = new Map(attachments.map((a) => [a.id, a] as const));
	const { displayText, content } = parseDraft(inputValue, map);
	const trimmed = displayText.trim();
	// Nothing to send (no text and no usable attachment).
	if (!trimmed && !content) return;
	// Don't send when a staged attachment is unsupported / mid-generation.
	if (sendBlocked) return;
	const text = trimmed || displayText;
	tabStore.setDraft(tabId, "");
	void tabStore.sendMessage(text, content ?? undefined);
}

function primaryAction() {
	if (showStop) {
		tabStore.stopGeneration(tabId);
		return;
	}
	submit();
}
</script>

<div class="flex flex-col">
	{#if attachmentWarning}
		<div class="px-3 pt-2 text-xs text-warning flex items-start gap-1">
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true">
				<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
				<line x1="12" y1="9" x2="12" y2="13"></line>
				<line x1="12" y1="17" x2="12.01" y2="17"></line>
			</svg>
			<span>{attachmentWarning}</span>
		</div>
	{/if}
	<!-- Top bar: expanding textarea + send/stop action -->
	<div class="flex items-end gap-2 px-3 pt-3 pb-2">
		<textarea
			bind:this={inputEl}
			value={inputValue}
			rows="1"
			placeholder="Type a message... (paste an image or PDF to attach)"
			class="textarea textarea-ghost flex-1 resize-none leading-normal !min-h-0 h-auto"
			onkeydown={handleKeydown}
			oninput={handleInput}
			onpaste={handlePaste}
		></textarea>
		<!-- Single fixed-width button across all states so the layout never
		     shifts when it morphs between Send and Stop. -->
		<button
			type="button"
			class="btn w-20 shrink-0 {showStop ? 'btn-error btn-outline' : 'btn-primary'}"
			disabled={!showStop && !hasText && !hasAttachments || sendBlocked}
			onclick={primaryAction}
			title={showStop ? "Stop generation" : sendBlocked ? (attachmentWarning ?? "Cannot send") : "Send message"}
		>
			{#if showStop}
				<span class="loading loading-spinner loading-sm"></span>
				Stop
			{:else}
				Send
			{/if}
		</button>
	</div>

	<!-- Bottom bar: status icon · context progress · token count -->
	<div class="flex items-center gap-2 px-3 pb-2 text-xs text-base-content/50">
		<!-- Status icon -->
		<span class="shrink-0">
			{#if agentStatus === "running"}
				<span class="loading loading-spinner loading-xs text-primary"></span>
			{:else if agentStatus === "error"}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 text-error" aria-label="Error">
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="12" y1="8" x2="12" y2="12"></line>
					<line x1="12" y1="16" x2="12.01" y2="16"></line>
				</svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 text-success" aria-label="Idle">
					<polyline points="20 6 9 17 4 12"></polyline>
				</svg>
			{/if}
		</span>

		<!-- Context-window fill bar -->
		{#if usage.percent !== null}
			<progress
				class="progress flex-1 h-2 {fillClass(usage.percent)}"
				value={usage.percent}
				max="100"
			></progress>
		{:else}
			<!-- Model's max context is unknown → inert, disabled bar. -->
			<progress class="progress flex-1 h-2 opacity-40" value="0" max="100"></progress>
		{/if}

		<!-- Context size + percent -->
		<span class="shrink-0 font-mono whitespace-nowrap">
			{#if hasUsage}
				{fmtCompact(usage.current)}{#if usage.max !== null}<span class="text-base-content/40"> / {fmtCompact(usage.max)}</span>{/if}
				{#if usage.percent !== null}
					<span class="ml-1">· {usage.percent.toFixed(1)}%</span>
				{/if}
			{:else}
				<span class="text-base-content/40">— tokens</span>
			{/if}
		</span>
	</div>
</div>
