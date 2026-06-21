import { createLogger, type HostAPI, type ToolExecuteContext } from "@dispatch/kernel";
import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import { describe, expect, it, vi } from "vitest";
import { activate, extension, manifest } from "./extension.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
	return {
		toolCallId: "test-call-1",
		onOutput: () => {},
		signal: new AbortController().signal,
		log: createLogger(
			{ extensionId: "test" },
			{ emit: () => {} },
			{ now: () => 0, newId: () => "id" },
		),
		...overrides,
	};
}

interface FakeHost {
	readonly host: HostAPI;
	readonly registry: SurfaceRegistry;
	readonly defineTool: ReturnType<typeof vi.fn>;
	readonly getProvider: () => SurfaceProvider | undefined;
}

function makeFakeHost(): FakeHost {
	const defineTool = vi.fn();
	let provider: SurfaceProvider | undefined;
	const registry: SurfaceRegistry = {
		register(p) {
			provider = p;
			return () => {
				provider = undefined;
			};
		},
		getCatalog() {
			return provider === undefined ? [] : [provider.catalogEntry];
		},
		getSurface(id) {
			if (provider === undefined) return undefined;
			return provider.catalogEntry.id === id ? provider : undefined;
		},
	};
	const host = {
		defineTool,
		getService: () => registry,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			span: vi.fn(() => ({ end: vi.fn() })),
		},
	} as unknown as HostAPI;
	return { host, registry, defineTool, getProvider: () => provider };
}

describe("todo manifest", () => {
	it("declares todo_write contribution + surface-registry dependency", () => {
		expect(manifest.id).toBe("todo");
		expect(manifest.activation).toBe("eager");
		expect(manifest.trust).toBe("bundled");
		expect(manifest.dependsOn).toEqual(["surface-registry"]);
		expect(manifest.contributes).toEqual({ tools: ["todo_write"] });
		expect(manifest.capabilities).toEqual({});
	});

	it("extension bundles the manifest + activate", () => {
		expect(extension.manifest).toBe(manifest);
		expect(typeof extension.activate).toBe("function");
	});
});

describe("todo activation", () => {
	it("activate registers the todo_write tool", () => {
		const { host, defineTool } = makeFakeHost();
		activate(host);
		expect(defineTool).toHaveBeenCalledTimes(1);
		const tool = defineTool.mock.calls[0]?.[0];
		if (!tool) throw new Error("no tool registered");
		expect(tool.name).toBe("todo_write");
		expect(tool.concurrencySafe).toBe(false);
	});

	it("activate registers a surface with scope 'conversation'", () => {
		const { host, getProvider } = makeFakeHost();
		activate(host);
		const provider = getProvider();
		if (!provider) throw new Error("no surface provider registered");
		expect(provider.catalogEntry.id).toBe("todo");
		expect(provider.catalogEntry.scope).toBe("conversation");
		expect(provider.catalogEntry.region).toBe("side");
		expect(provider.catalogEntry.title).toBe("Tasks");
	});

	it("surface getSpec returns todos for the conversation", async () => {
		const { host, defineTool, getProvider } = makeFakeHost();
		activate(host);
		const tool = defineTool.mock.calls[0]?.[0];
		if (!tool) throw new Error("no tool registered");
		await tool.execute(
			{ todos: [{ content: "a", status: "pending" }] },
			stubCtx({ conversationId: "c1" }),
		);
		const provider = getProvider();
		if (!provider) throw new Error("no surface provider registered");
		const spec = await provider.getSpec({ conversationId: "c1" });
		expect(spec.id).toBe("todo");
		expect(spec.fields).toHaveLength(1);
		const field = spec.fields[0];
		if (field === undefined || field.kind !== "custom") {
			throw new Error("expected a custom field");
		}
		const payload = field.payload as { todos: readonly { content: string }[] };
		expect(payload.todos).toHaveLength(1);
		expect(payload.todos[0]?.content).toBe("a");
	});

	it("surface subscribe notifies on todo_write", async () => {
		const { host, defineTool, getProvider } = makeFakeHost();
		activate(host);
		const provider = getProvider();
		if (!provider) throw new Error("no surface provider registered");
		const calls = { value: 0 };
		const unsub = provider.subscribe?.(() => {
			calls.value += 1;
		});
		const tool = defineTool.mock.calls[0]?.[0];
		if (!tool) throw new Error("no tool registered");
		await tool.execute(
			{ todos: [{ content: "x", status: "pending" }] },
			stubCtx({ conversationId: "c1" }),
		);
		expect(calls.value).toBe(1);
		if (unsub) unsub();
	});
});
