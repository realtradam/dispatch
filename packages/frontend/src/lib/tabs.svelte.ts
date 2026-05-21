import { config } from "./config.js";
import { appSettings } from "./settings.svelte.js";
import type {
	AgentEvent,
	ChatMessage,
	ContentSegment,
	DebugInfo,
	LogEntry,
	PermissionPrompt,
	TaskItem,
} from "./types.js";
import { wsClient } from "./ws.svelte.js";

function generateId() {
	return crypto.randomUUID();
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
}

function createTabStore() {
	let tabs: Tab[] = $state([]);
	let activeTabId: string | null = $state(null);
	let pendingPermissions: PermissionPrompt[] = $state([]);
	let permissionLog: LogEntry[] = $state([]);
	let configReloaded = $state(false);
	let isConnected = $state(false);

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
		};
		tabs = [...tabs, tab];
		activeTabId = id;

		// Auto-check default skills for injection with the first message
		autoCheckDefaultSkills();

		return tab;
	}

	function switchTab(id: string): void {
		if (tabs.some((t) => t.id === id)) {
			activeTabId = id;
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
				activeTabId = tabs[tabs.length - 1]?.id;
			} else {
				await createNewTab();
			}
		}
	}

	function updateTab(id: string, patch: Partial<Tab>): void {
		tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	function ensureAssistantMessage(tabId: string): ChatMessage {
		const tab = getTabById(tabId);
		if (!tab) throw new Error(`Tab not found: ${tabId}`);

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
		updateTab(tab.id, { messages: [...tab.messages, userMsg] });

		// Generate title from first user message
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
				}),
			});
			if (!res.ok) {
				const body = await res.text();
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
			}
		} catch (err) {
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

	function copyConversation(): string {
		const tab = getActiveTab();
		if (!tab) return "";
		const lines: string[] = [
			"=== Dispatch Conversation ===",
			`Tab: ${tab.title}`,
			`Model: ${tab.modelId ?? "default"}`,
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
		changeModel,
		setKey,
		replyPermission,
		copyConversation,
	};
}

export const tabStore = createTabStore();
