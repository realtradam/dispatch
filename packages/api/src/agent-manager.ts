import {
	Agent,
	type AgentEvent,
	type AgentStatus,
	createListFilesTool,
	createReadFileTool,
	createWriteFileTool,
} from "@dispatch/core";

const SYSTEM_PROMPT = `You are Dispatch, a helpful AI coding assistant. You have access to the following tools for working with files in the current working directory:

- read_file: Read the contents of a file
- write_file: Write content to a file (creates parent directories if needed)
- list_files: List files and directories

When asked to work with files, use these tools. Always confirm what you did after completing an action. Be concise and helpful.`;

export class AgentManager {
	private agent: Agent | null = null;
	private status: AgentStatus = "idle";
	private messageCount = 0;
	private eventListeners: Set<(event: AgentEvent) => void> = new Set();

	private getOrCreateAgent(): Agent {
		if (!this.agent) {
			const apiKey = process.env.OPENCODE_API_KEY ?? "";
			const model = process.env.DISPATCH_MODEL ?? "deepseek-v4-flash";
			const workingDirectory = process.env.DISPATCH_WORKING_DIR ?? process.cwd();

			const tools = [
				createReadFileTool(workingDirectory),
				createWriteFileTool(workingDirectory),
				createListFilesTool(workingDirectory),
			];

			this.agent = new Agent({
				model,
				apiKey,
				baseURL: "https://opencode.ai/zen/go/v1",
				systemPrompt: SYSTEM_PROMPT,
				tools,
				workingDirectory,
			});
		}
		return this.agent;
	}

	getStatus(): AgentStatus {
		return this.status;
	}

	getMessageCount(): number {
		return this.messageCount;
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	async processMessage(message: string): Promise<void> {
		const agent = this.getOrCreateAgent();

		this.messageCount += 1;

		try {
			for await (const event of agent.run(message)) {
				this.status = event.type === "status" ? event.status : this.status;
				this.emit(event);
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.status = "error";
			this.emit({ type: "error", error: errorMsg });
			this.emit({ type: "status", status: "error" });
		}
	}
}
