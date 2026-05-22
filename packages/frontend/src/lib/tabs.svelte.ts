import { config } from "./config.js";
import { appSettings } from "./settings.svelte.js";
import type {
	AgentEvent,
	ChatMessage,
	ContentSegment,
	DebugInfo,
	LogEntry,
	PermissionPrompt,
	QueuedMessage,
	TaskItem,
} from "./types.js";
import { wsClient } from "./ws.svelte.js";

function generateId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback for non-secure contexts (HTTP over Tailscale/LAN)
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function makeDebugInfo(overrides: Partial<DebugInfo> = {}): DebugInfo {
	return {
		timestamp: new Date().toISOString(),
		connectionStatus: wsClient.connectionStatus,
		...overrides,
	};
}

export interface Tab {
	id: string;
	title: string;
	messages: ChatMessage[];
	agentStatus: "idle" | "running" | "error";
	keyId: string | null;
	modelId: string | null;
	reasoningEffort: string;
	currentAssistantId: string | null;
	tasks: TaskItem[];
	injectedSkills: string[];
	/** null = user-owned tab, string = spawned by that tab */
	parentTabId: string | null;
	/** Persistent tabs stay until manually closed. Temp tabs disappear when agent finishes. */
	persistent: boolean;
	/** Slug of the selected agent, or null for manual mode */
	agentSlug: string | null;
	/** Scope of the selected agent */
	agentScope: string | null;
	/** Custom working directory override for this tab */
	workingDirectory: string | null;
	/** Messages queued to be sent once the agent finishes its current run */
	queuedMessages: QueuedMessage[];
}

function createTabStore() {
	let tabs: Tab[] = $state([]);
	let activeTabId: string | null = $state(null);
	let pendingPermissions: PermissionPrompt[] = $state([]);
	let permissionLog: LogEntry[] = $state([]);
	let configReloaded = $state(false);
	let isConnected = $state(false);

	// Track message IDs that were consumed before the POST /chat response arrived.
	// Keyed by queueId — if consumed before we process the response, we skip the queued state.
	const recentlyConsumedIds = new Set<string>();

	// Clear any stale listeners from HMR reloads, then register
	wsClient.clearCallbacks();
	wsClient.onEvent((event) => {
		handleEvent(event as AgentEvent & { tabId?: string });
	});

	$effect.root(() => {
		$effect(() => {
			isConnected = wsClient.connectionStatus === "connected";
		});
	});

	function getActiveTab(): Tab | undefined {
		return tabs.find((t) => t.id === activeTabId);
	}

	function getTabById(id: string): Tab | undefined {
		return tabs.find((t) => t.id === id);
	}

	async function createNewTab(): Promise<Tab> {
		const id = generateId();
		const title = "New Tab";

		// Create on backend
		try {
			await fetch(`${config.apiBase}/tabs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, title }),
			});
		} catch {
			// Continue even if backend fails — tab works locally
		}

		const tab: Tab = {
			id,
			title,
			messages: [],
			agentStatus: "idle",
			keyId: null,
			modelId: null,
			reasoningEffort: "max",
			currentAssistantId: null,
			tasks: [],
			injectedSkills: [],
			parentTabId: null,
			persistent: true,
			agentSlug: null,
			agentScope: null,
			workingDirectory: null,
			queuedMessages: [],
		};
		tabs = [...tabs, tab];
		activeTabId = id;

		// Auto-check default skills then apply default agent (sequential to avoid race)
		void (async () => {
			await autoCheckDefaultSkills();
			await autoSelectDefaultAgent(id);
		})();

		return tab;
	}

	function switchTab(id: string): void {
		if (tabs.some((t) => t.id === id)) {
			activeTabId = id;
		}
	}

	function promoteTab(id: string): void {
		const tab = getTabById(id);
		if (!tab) return;
		updateTab(id, { persistent: true });
		switchTab(id);
	}

	async function openAgentTab(agentId: string): Promise<void> {
		const tab = getTabById(agentId);
		if (tab) {
			updateTab(agentId, { persistent: true });
			switchTab(agentId);
			return;
		}

		// Tab not found locally — try to fetch from backend
		try {
			const tabRes = await fetch(`${config.apiBase}/tabs/${agentId}`);
			if (!tabRes.ok) return; // 404 or other error — tab doesn't exist
			const tabData = (await tabRes.json()) as {
				id: string;
				title: string;
				keyId?: string | null;
				modelId?: string | null;
				status?: string;
				parentTabId?: string | null;
			};

			const messagesRes = await fetch(`${config.apiBase}/tabs/${agentId}/messages`);
			const messagesData = messagesRes.ok
				? ((await messagesRes.json()) as {
						messages: Array<{
							id?: string;
							role: string;
							contentJson: string;
							thinking: string | null;
						}>;
					})
				: { messages: [] };

			const chatMessages: ChatMessage[] = messagesData.messages.flatMap((m) => {
				try {
					return [
						{
							id: m.id ?? generateId(),
							role: m.role as ChatMessage["role"],
							content: JSON.parse(m.contentJson) as ContentSegment[],
							thinking: m.thinking ?? undefined,
							isStreaming: false,
						},
					];
				} catch {
					return [];
				}
			});

			const newTab: Tab = {
				id: agentId,
				title: tabData.title,
				messages: chatMessages,
				agentStatus: "idle",
				keyId: tabData.keyId ?? null,
				modelId: tabData.modelId ?? null,
				reasoningEffort: "max",
				currentAssistantId: null,
				tasks: [],
				injectedSkills: [],
				parentTabId: tabData.parentTabId ?? null,
				persistent: true,
				agentSlug: null,
				agentScope: null,
				workingDirectory: null,
				queuedMessages: [],
			};
			tabs = [...tabs, newTab];
			activeTabId = agentId;
		} catch (err) {
			console.error("openAgentTab failed:", err);
		}
	}

	async function closeTab(id: string): Promise<void> {
		const tab = getTabById(id);
		if (!tab) return;

		// Archive on backend (also stops any running agent)
		try {
			await fetch(`${config.apiBase}/tabs/${id}`, { method: "DELETE" });
		} catch {
			// Continue with local removal
		}

		tabs = tabs.filter((t) => t.id !== id);

		// If we closed the active tab, switch to the last remaining or create a new one
		if (activeTabId === id) {
			if (tabs.length > 0) {
				const fallback = tabs[tabs.length - 1];
				if (fallback && !fallback.persistent) {
					updateTab(fallback.id, { persistent: true });
				}
				activeTabId = fallback?.id ?? null;
			} else {
				await createNewTab();
			}
		}
	}

	function updateTab(id: string, patch: Partial<Tab>): void {
		tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	function ensureAssistantMessage(tabId: string): ChatMessage | null {
		const tab = getTabById(tabId);
		if (!tab) return null;

		if (tab.currentAssistantId) {
			const existing = tab.messages.find((m) => m.id === tab.currentAssistantId);
			if (existing) return existing;
		}

		const id = generateId();
		const newMsg: ChatMessage = {
			id,
			role: "assistant",
			content: [],
			thinking: "",
			isStreaming: true,
		};
		updateTab(tabId, {
			currentAssistantId: id,
			messages: [...tab.messages, newMsg],
		});
		return newMsg;
	}

	function updateMessages(tabId: string, updater: (msgs: ChatMessage[]) => ChatMessage[]): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		updateTab(tabId, { messages: updater(tab.messages) });
	}

	function handleEvent(event: AgentEvent & { tabId?: string }): void {
		const tabId = event.tabId;

		switch (event.type) {
			case "status": {
				if (tabId) {
					updateTab(tabId, { agentStatus: event.status });
					if (event.status === "idle" || event.status === "error") {
						updateTab(tabId, { currentAssistantId: null });
						const tab = getTabById(tabId);
						if (tab && !tab.persistent && tabId !== activeTabId) {
							tabs = tabs.filter((t) => t.id !== tabId);
						}
					}
				}
				break;
			}
			case "reasoning-delta": {
				if (!tabId) break;
				ensureAssistantMessage(tabId);
				const tab = getTabById(tabId);
				if (!tab) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) =>
						m.id === tab.currentAssistantId
							? { ...m, thinking: (m.thinking ?? "") + event.delta }
							: m,
					),
				);
				break;
			}
			case "text-delta": {
				if (!tabId) break;
				ensureAssistantMessage(tabId);
				const tab2 = getTabById(tabId);
				if (!tab2) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) => {
						if (m.id !== tab2.currentAssistantId) return m;
						const segments = [...m.content];
						const last = segments[segments.length - 1];
						if (last && last.type === "text") {
							segments[segments.length - 1] = { ...last, text: last.text + event.delta };
						} else {
							segments.push({ type: "text", text: event.delta });
						}
						return { ...m, content: segments, isStreaming: true };
					}),
				);
				break;
			}
			case "tool-call": {
				if (!tabId) break;
				ensureAssistantMessage(tabId);
				const tab3 = getTabById(tabId);
				if (!tab3) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) => {
						if (m.id !== tab3.currentAssistantId) return m;
						const segments: ContentSegment[] = [
							...m.content,
							{
								type: "tool-call",
								id: event.toolCall.id,
								name: event.toolCall.name,
								arguments: event.toolCall.arguments,
							},
						];
						return { ...m, content: segments };
					}),
				);
				break;
			}
			case "tool-result": {
				if (!tabId) break;
				const tab4 = getTabById(tabId);
				if (!tab4) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) => {
						if (m.id !== tab4.currentAssistantId) return m;
						return {
							...m,
							content: m.content.map((seg) => {
								if (seg.type === "tool-call" && seg.id === event.toolResult.toolCallId) {
									return {
										...seg,
										result: event.toolResult.result,
										isError: event.toolResult.isError,
									};
								}
								return seg;
							}),
						};
					}),
				);
				break;
			}
			case "done": {
				if (!tabId) break;
				const tab5 = getTabById(tabId);
				if (!tab5) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) => (m.id === tab5.currentAssistantId ? { ...m, isStreaming: false } : m)),
				);
				updateTab(tabId, { currentAssistantId: null });
				break;
			}
			case "error": {
				if (tabId) {
					const errMsg: ChatMessage = {
						id: generateId(),
						role: "assistant",
						content: [{ type: "text", text: `Error: ${event.error}` }],
						isStreaming: false,
						debugInfo: makeDebugInfo({ error: event.error }),
					};
					const tab6 = getTabById(tabId);
					if (tab6) {
						updateTab(tabId, {
							messages: [...tab6.messages, errMsg],
							currentAssistantId: null,
							agentStatus: "error",
						});
					}
				}
				break;
			}
			case "permission-prompt": {
				pendingPermissions = event.pending;
				break;
			}
			case "task-list-update": {
				if (tabId) {
					updateTab(tabId, { tasks: event.tasks });
				}
				break;
			}
			case "config-reload": {
				configReloaded = true;
				setTimeout(() => {
					configReloaded = false;
				}, 2500);
				break;
			}
			case "shell-output": {
				if (!tabId) break;
				const tab7 = getTabById(tabId);
				if (!tab7) break;
				updateMessages(tabId, (msgs) =>
					msgs.map((m) => {
						if (m.id !== tab7.currentAssistantId) return m;
						const segments = [...m.content];
						for (let i = segments.length - 1; i >= 0; i--) {
							const seg = segments[i];
							if (seg && seg.type === "tool-call") {
								segments[i] = {
									...seg,
									shellOutput: {
										stdout:
											(seg.shellOutput?.stdout ?? "") +
											(event.stream === "stdout" ? event.data : ""),
										stderr:
											(seg.shellOutput?.stderr ?? "") +
											(event.stream === "stderr" ? event.data : ""),
									},
								};
								break;
							}
						}
						return { ...m, content: segments };
					}),
				);
				break;
			}
			case "tab-created": {
				const newTabEvent = event as AgentEvent & {
					id: string;
					title: string;
					keyId: string | null;
					modelId: string | null;
					parentTabId: string | null;
					workingDirectory: string | null;
				};
				// Only add if we don't already have this tab
				if (!getTabById(newTabEvent.id)) {
					const tab: Tab = {
						id: newTabEvent.id,
						title: newTabEvent.title,
						messages: [],
						agentStatus: "running",
						keyId: newTabEvent.keyId ?? null,
						modelId: newTabEvent.modelId ?? null,
						reasoningEffort: "max",
						currentAssistantId: null,
						tasks: [],
						injectedSkills: [],
						parentTabId: newTabEvent.parentTabId ?? null,
						persistent: newTabEvent.parentTabId == null,
						agentSlug: null,
						agentScope: null,
						workingDirectory: newTabEvent.workingDirectory ?? null,
						queuedMessages: [],
					};
					tabs = [...tabs, tab];
				}
				break;
			}
			case "message-queued": {
				if (!tabId) break;
				const mqEvent = event as AgentEvent & { tabId: string; messageId: string; message: string };
				const mqTab = getTabById(tabId);
				if (!mqTab) break;
				// Only add to queuedMessages if not already tracked (might have been added
				// optimistically by sendMessage using the same queueId)
				const alreadyQueued = mqTab.queuedMessages.some((m) => m.id === mqEvent.messageId);
				if (!alreadyQueued) {
					// Message came from another client/session — add it fresh
					const qm: QueuedMessage = {
						id: mqEvent.messageId,
						message: mqEvent.message,
						timestamp: Date.now(),
					};
					updateTab(tabId, { queuedMessages: [...mqTab.queuedMessages, qm] });
					// Also add as a user chat message if not already present
					const tabAfterQm = getTabById(tabId);
					const existingMsg = tabAfterQm?.messages.find(
						(m) => m.id === `queued-${mqEvent.messageId}` || m.id === mqEvent.messageId,
					);
					if (!existingMsg) {
						const userMsg: ChatMessage = {
							id: `queued-${mqEvent.messageId}`,
							role: "user",
							content: [{ type: "text", text: mqEvent.message }],
						};
						updateTab(tabId, { messages: [...(tabAfterQm?.messages ?? []), userMsg] });
					}
				}
				// If alreadyQueued, the optimistic update already put everything in place with the
				// correct `queued-${messageId}` id — nothing more to do.
				break;
			}
			case "message-consumed": {
				if (!tabId) break;
				const mcEvent = event as AgentEvent & { tabId: string; messageIds: string[] };
				const mcTab = getTabById(tabId);
				if (!mcTab) break;
				// Track recently consumed IDs so sendMessage can detect early consumption
				for (const id of mcEvent.messageIds) {
					recentlyConsumedIds.add(id);
					setTimeout(() => recentlyConsumedIds.delete(id), 10000);
				}
				updateTab(tabId, {
					queuedMessages: mcTab.queuedMessages.filter((m) => !mcEvent.messageIds.includes(m.id)),
				});
				// Split the current assistant message: finalize it, then insert
				// the consumed user messages after it. Subsequent streaming events
				// will create a NEW assistant message block below.
				const currentAssistantId = mcTab.currentAssistantId;
				updateMessages(tabId, (msgs) => {
					// Extract consumed messages
					const consumed: ChatMessage[] = [];
					const rest: ChatMessage[] = [];
					for (const m of msgs) {
						if (m.id.startsWith("queued-")) {
							const queuedId = m.id.slice(7);
							if (mcEvent.messageIds.includes(queuedId)) {
								consumed.push({ ...m, id: queuedId });
								continue;
							}
						}
						rest.push(m);
					}
					if (consumed.length === 0) return msgs;

					// Mark the current assistant message as done streaming
					const result = rest.map((m) =>
						m.id === currentAssistantId ? { ...m, isStreaming: false } : m,
					);

					// Insert consumed messages right after the current assistant message
					let insertIdx = result.length;
					for (let i = result.length - 1; i >= 0; i--) {
						if (result[i]?.id === currentAssistantId) {
							insertIdx = i + 1;
							break;
						}
					}
					result.splice(insertIdx, 0, ...consumed);
					return result;
				});
				// Clear currentAssistantId so the next streaming event creates
				// a new assistant message block after the user's message
				updateTab(tabId, { currentAssistantId: null });
				break;
			}
			case "message-cancelled": {
				if (!tabId) break;
				const cancelEvent = event as AgentEvent & { tabId: string; messageId: string };
				const cancelTab = getTabById(tabId);
				if (!cancelTab) break;
				updateTab(tabId, {
					queuedMessages: cancelTab.queuedMessages.filter((m) => m.id !== cancelEvent.messageId),
					messages: cancelTab.messages.filter(
						(m) => !(m.role === "user" && m.id === `queued-${cancelEvent.messageId}`),
					),
				});
				break;
			}
		}
	}

	async function autoCheckDefaultSkills(): Promise<void> {
		try {
			const res = await fetch(`${config.apiBase}/skills`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				skills?: Array<{
					name: string;
					scope: string;
					directory: string;
				}>;
			};
			const defaultSkills = (data.skills ?? []).filter((s) => s.directory === "default");
			if (defaultSkills.length === 0) return;
			const checks: Record<string, boolean> = { ...appSettings.skillChecks };
			for (const skill of defaultSkills) {
				checks[`${skill.scope}:${skill.name}`] = true;
			}
			appSettings.skillChecks = checks;
		} catch {
			// Silently ignore — skills will still be available for manual checking
		}
	}

	async function autoSelectDefaultAgent(tabId: string): Promise<void> {
		try {
			const res = await fetch(`${config.apiBase}/agents`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				agents?: Array<{
					slug: string;
					scope: string;
					name: string;
					skills: string[];
					tools: string[];
					models: Array<{ key_id: string; model_id: string }>;
					cwd?: string;
				}>;
			};
			const agents = data.agents ?? [];
			const defaultAgent = agents.find(
				(a: { slug: string; scope: string }) => a.slug === "default" && a.scope === "global",
			);
			if (!defaultAgent) return;

			const tab = getTabById(tabId);
			if (!tab) return;

			// Apply the default agent
			const firstModel = defaultAgent.models[0];
			const patch: Partial<Tab> = {
				agentSlug: defaultAgent.slug,
				agentScope: defaultAgent.scope,
				workingDirectory: defaultAgent.cwd || null,
			};
			if (firstModel) {
				patch.keyId = firstModel.key_id;
				patch.modelId = firstModel.model_id;
			}
			updateTab(tabId, patch);

			// Merge the agent's skills into existing checked skills
			if (defaultAgent.skills.length > 0) {
				const checks: Record<string, boolean> = { ...appSettings.skillChecks };
				for (const skillKey of defaultAgent.skills) {
					checks[skillKey] = true;
				}
				appSettings.skillChecks = checks;
			}

			// Apply tool permissions
			const perms: Record<string, boolean> = {};
			for (const key of Object.keys(appSettings.toolPerms)) {
				perms[key] = false;
			}
			for (const tool of defaultAgent.tools) {
				perms[tool] = true;
			}
			appSettings.toolPerms = perms;

			// Persist to backend
			if (firstModel) {
				fetch(`${config.apiBase}/tabs/${tabId}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keyId: firstModel.key_id, modelId: firstModel.model_id }),
				}).catch(() => {});
			}
		} catch {
			// Silently ignore
		}
	}

	async function fetchSkillContent(scope: string, name: string): Promise<string | null> {
		try {
			const res = await fetch(
				`${config.apiBase}/skills/${encodeURIComponent(name)}?scope=${scope}`,
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { content?: string };
			return data.content ?? null;
		} catch {
			return null;
		}
	}

	async function sendMessage(text: string): Promise<void> {
		const tab = getActiveTab();
		if (!tab) return;

		// Fetch content for checked skills and build the message to send
		let messageToSend = text;
		const checkedKeys = Object.entries(appSettings.skillChecks)
			.filter(([, v]) => v)
			.map(([k]) => k);

		if (checkedKeys.length > 0) {
			const skillSections: string[] = [];
			for (const key of checkedKeys) {
				const [scope, ...nameParts] = key.split(":");
				const name = nameParts.join(":");
				if (!scope || !name) continue;
				const content = await fetchSkillContent(scope, name);
				if (content) {
					skillSections.push(`<skill name="${name}">\n${content}\n</skill>`);
				}
			}
			if (skillSections.length > 0) {
				messageToSend = `[The following skills have been activated for this message]\n\n${skillSections.join("\n\n")}\n\n---\n\n${text}`;
			}

			// Track injected skills on the tab
			const newInjected = [...new Set([...tab.injectedSkills, ...checkedKeys])];
			updateTab(tab.id, { injectedSkills: newInjected });

			// Clear all checks
			appSettings.skillChecks = {};
		}

		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			content: [{ type: "text", text }],
		};

		// If the agent is currently running, we expect the POST to be queued.
		// Optimistically assign the queued- prefix and add to queuedMessages BEFORE
		// the POST so that the WS "message-queued" event (which may arrive before
		// the HTTP response) can match the existing chat message instead of creating
		// a duplicate.
		const isRunning = tab.agentStatus === "running";
		let queueId: string | null = null;
		if (isRunning) {
			queueId = generateId();
			userMsg.id = `queued-${queueId}`;
			// Pre-populate queuedMessages so WS event finds it immediately
			tab.queuedMessages = [
				...tab.queuedMessages,
				{ id: queueId, message: text, timestamp: Date.now() },
			];
		}

		updateTab(tab.id, { messages: [...tab.messages, userMsg] }); // Generate title from first user message
		if (tab.messages.length === 0 || (tab.messages.length === 1 && tab.title === "New Tab")) {
			const titleText = text.length > 50 ? `${text.slice(0, 47)}...` : text;
			updateTab(tab.id, { title: titleText });
			fetch(`${config.apiBase}/tabs/${tab.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: titleText }),
			}).catch(() => {});
		}

		// Save settings to DB before sending (bakes in on send)
		const settingsSaves: Promise<unknown>[] = [];

		if (appSettings.systemPrompt !== appSettings.savedSystemPrompt) {
			appSettings.savedSystemPrompt = appSettings.systemPrompt;
			settingsSaves.push(
				fetch(`${config.apiBase}/tabs/settings/system_prompt`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: appSettings.systemPrompt }),
				}).catch(() => {}),
			);
		}

		if (appSettings.toolPermsDirty) {
			const perms = appSettings.toolPerms;
			appSettings.savedToolPerms = { ...perms };
			for (const [id, enabled] of Object.entries(perms)) {
				settingsSaves.push(
					fetch(`${config.apiBase}/tabs/settings/perm_${id}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ value: enabled ? "allow" : "ask" }),
					}).catch(() => {}),
				);
			}
		}

		if (settingsSaves.length > 0) {
			await Promise.all(settingsSaves);
		}

		try {
			const res = await fetch(`${config.apiBase}/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tabId: tab.id,
					message: messageToSend,
					...(tab.keyId ? { keyId: tab.keyId } : {}),
					...(tab.modelId ? { modelId: tab.modelId } : {}),
					reasoningEffort: tab.reasoningEffort,
					...(tab.workingDirectory ? { workingDirectory: tab.workingDirectory } : {}),
					...(queueId ? { queueId } : {}),
				}),
			});
			if (!res.ok) {
				const body = await res.text();
				// Rollback optimistic queued state on error
				if (queueId) {
					const currentTab = getTabById(tab.id);
					if (currentTab) {
						updateTab(tab.id, {
							queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
						});
					}
					updateMessages(tab.id, (msgs) =>
						msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
					);
				}
				const errMsg: ChatMessage = {
					id: generateId(),
					role: "assistant",
					content: [{ type: "text", text: `Error: Failed to send message (HTTP ${res.status})` }],
					isStreaming: false,
					debugInfo: makeDebugInfo({
						error: `HTTP ${res.status}`,
						httpStatus: res.status,
						httpBody: body,
					}),
				};
				updateTab(tab.id, { messages: [...(getTabById(tab.id)?.messages ?? []), errMsg] });
			} else {
				const responseData = (await res.json()) as { status: string; messageId?: string };
				if (responseData.status === "queued" && responseData.messageId) {
					// The backend confirmed the message was queued with the ID we sent (queueId).
					// If the message was already consumed before we got here (super-fast agent),
					// clean up the optimistic queued state.
					if (queueId && recentlyConsumedIds.has(queueId)) {
						recentlyConsumedIds.delete(queueId);
						// queuedMessages and the queued- prefix have already been cleaned up by
						// the message-consumed handler. Nothing more to do.
					}
					// Otherwise everything is already in place from the optimistic update above.
				} else if (responseData.status === "ok") {
					// Agent wasn't running after all — undo the optimistic queued state if we set it.
					if (queueId) {
						const currentTab = getTabById(tab.id);
						if (currentTab) {
							updateTab(tab.id, {
								queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
							});
						}
						// Restore the message to a normal (non-queued) ID
						updateMessages(tab.id, (msgs) =>
							msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
						);
					}
				}
			}
		} catch (err) {
			// Rollback optimistic queued state on network error
			if (queueId) {
				const currentTab = getTabById(tab.id);
				if (currentTab) {
					updateTab(tab.id, {
						queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
					});
				}
				updateMessages(tab.id, (msgs) =>
					msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
				);
			}
			const errMsg: ChatMessage = {
				id: generateId(),
				role: "assistant",
				content: [{ type: "text", text: "Error: Could not reach the server" }],
				isStreaming: false,
				debugInfo: makeDebugInfo({ error: err instanceof Error ? err.message : String(err) }),
			};
			updateTab(tab.id, { messages: [...(getTabById(tab.id)?.messages ?? []), errMsg] });
		}
	}

	function changeModel(keyId: string, modelId: string): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { keyId, modelId });

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId, modelId }),
		}).catch(() => {});
	}

	function setKey(keyId: string): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { keyId, modelId: null });

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId, modelId: null }),
		}).catch(() => {});
	}

	function setWorkingDirectory(dir: string | null): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { workingDirectory: dir || null });
	}

	function setAgent(
		agent: {
			slug: string;
			scope: string;
			skills: string[];
			tools: string[];
			models: Array<{ key_id: string; model_id: string }>;
			cwd?: string;
		} | null,
	): void {
		const tab = getActiveTab();
		if (!tab) return;

		if (!agent) {
			// Switch back to manual mode — clear agent and reset working directory
			updateTab(tab.id, { agentSlug: null, agentScope: null, workingDirectory: null });
			return;
		}

		// Apply agent's first model as the active key+model
		const firstModel = agent.models[0];
		const patch: Partial<Tab> = {
			agentSlug: agent.slug,
			agentScope: agent.scope,
			workingDirectory: agent.cwd || null,
		};
		if (firstModel) {
			patch.keyId = firstModel.key_id;
			patch.modelId = firstModel.model_id;
		}
		updateTab(tab.id, patch);

		// Reset and apply the agent's skills (don't accumulate from previous agents)
		const checks: Record<string, boolean> = {};
		for (const skillKey of agent.skills) {
			checks[skillKey] = true;
		}
		appSettings.skillChecks = checks;

		// Always reset tool permissions to agent's allowlist (even if empty)
		const perms: Record<string, boolean> = {};
		for (const key of Object.keys(appSettings.toolPerms)) {
			perms[key] = false;
		}
		for (const tool of agent.tools) {
			perms[tool] = true;
		}
		appSettings.toolPerms = perms;

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...(firstModel ? { keyId: firstModel.key_id, modelId: firstModel.model_id } : {}),
			}),
		}).catch(() => {});
	}

	function replyPermission(id: string, reply: "once" | "always" | "reject"): void {
		if (wsClient.connectionStatus !== "connected") return;
		const prompt = pendingPermissions.find((p) => p.id === id);
		wsClient.send({ type: "permission-reply", id, reply });
		pendingPermissions = pendingPermissions.filter((p) => p.id !== id);
		if (prompt) {
			permissionLog = [
				...permissionLog,
				{
					id: generateId(),
					permission: prompt.permission,
					patterns: prompt.patterns,
					action: reply,
					timestamp: new Date().toISOString(),
					description: prompt.description,
				},
			];
		}
	}

	async function cancelQueuedMessage(tabId: string, messageId: string): Promise<void> {
		const tab = getTabById(tabId);
		if (tab) {
			updateTab(tabId, {
				queuedMessages: tab.queuedMessages.filter((m) => m.id !== messageId),
				messages: tab.messages.filter(
					(m) => !(m.role === "user" && m.id === `queued-${messageId}`),
				),
			});
		}
		try {
			await fetch(`${config.apiBase}/chat/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tabId, messageId }),
			});
		} catch {
			// ignore
		}
	}

	function copyConversation(): string {
		const tab = getActiveTab();
		if (!tab) return "";

		const enabledTools = Object.entries(appSettings.savedToolPerms)
			.filter(([, v]) => v)
			.map(([k]) => k);

		const lines: string[] = [
			"=== Dispatch Conversation ===",
			`Tab ID: ${tab.id}`,
			`Tab: ${tab.title}`,
			`Model: ${tab.modelId ?? "default"}`,
			`Tools: ${enabledTools.length > 0 ? enabledTools.join(", ") : "none"}`,
			`Injected Skills: ${tab.injectedSkills.length > 0 ? tab.injectedSkills.join(", ") : "none"}`,
			`Total tabs: ${tabs.length}`,
			`All tab IDs: ${tabs.map((t) => t.id).join(", ")}`,
			"",
		];
		for (const msg of tab.messages) {
			const role = msg.role === "user" ? "User" : msg.role === "system" ? "System" : "Assistant";
			lines.push(`--- ${role} ---`);
			if (msg.thinking) lines.push(`  [Thinking]: ${msg.thinking}`);
			for (const seg of msg.content) {
				if (seg.type === "text") lines.push(seg.text);
				else if (seg.type === "tool-call") {
					lines.push(`  [Tool: ${seg.name}]`);
					if (seg.result !== undefined) lines.push(`  Result: ${seg.result}`);
				}
			}
			lines.push("");
		}
		return lines.join("\n");
	}

	return {
		get tabs() {
			return tabs;
		},
		get activeTabId() {
			return activeTabId;
		},
		get activeTab() {
			return getActiveTab();
		},
		get isConnected() {
			return isConnected;
		},
		get pendingPermissions() {
			return pendingPermissions;
		},
		get permissionLog() {
			return permissionLog;
		},
		get configReloaded() {
			return configReloaded;
		},
		createNewTab,
		switchTab,
		closeTab,
		sendMessage,
		cancelQueuedMessage,
		changeModel,
		setKey,
		setAgent,
		replyPermission,
		copyConversation,
		promoteTab,
		openAgentTab,
		setWorkingDirectory,
	};
}

export const tabStore = createTabStore();
