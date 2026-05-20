<script lang="ts">
	import { Marked } from "marked";
	import { markedHighlight } from "marked-highlight";
	import hljs from "highlight.js/lib/core";
	// Hot set — matches roughly what ChatGPT preloads. Registered eagerly so
	// common code blocks highlight on first paint without a network roundtrip.
	import bash from "highlight.js/lib/languages/bash";
	import c from "highlight.js/lib/languages/c";
	import cpp from "highlight.js/lib/languages/cpp";
	import csharp from "highlight.js/lib/languages/csharp";
	import css from "highlight.js/lib/languages/css";
	import go from "highlight.js/lib/languages/go";
	import java from "highlight.js/lib/languages/java";
	import javascript from "highlight.js/lib/languages/javascript";
	import json from "highlight.js/lib/languages/json";
	import markdown from "highlight.js/lib/languages/markdown";
	import php from "highlight.js/lib/languages/php";
	import plaintext from "highlight.js/lib/languages/plaintext";
	import python from "highlight.js/lib/languages/python";
	import ruby from "highlight.js/lib/languages/ruby";
	import rust from "highlight.js/lib/languages/rust";
	import shell from "highlight.js/lib/languages/shell";
	import sql from "highlight.js/lib/languages/sql";
	import typescript from "highlight.js/lib/languages/typescript";
	import xml from "highlight.js/lib/languages/xml";
	import yaml from "highlight.js/lib/languages/yaml";

	hljs.registerLanguage("bash", bash);
	hljs.registerLanguage("c", c);
	hljs.registerLanguage("cpp", cpp);
	hljs.registerLanguage("csharp", csharp);
	hljs.registerLanguage("css", css);
	hljs.registerLanguage("go", go);
	hljs.registerLanguage("java", java);
	hljs.registerLanguage("javascript", javascript);
	hljs.registerLanguage("json", json);
	hljs.registerLanguage("markdown", markdown);
	hljs.registerLanguage("php", php);
	hljs.registerLanguage("plaintext", plaintext);
	hljs.registerLanguage("python", python);
	hljs.registerLanguage("ruby", ruby);
	hljs.registerLanguage("rust", rust);
	hljs.registerLanguage("shell", shell);
	hljs.registerLanguage("sql", sql);
	hljs.registerLanguage("typescript", typescript);
	hljs.registerLanguage("xml", xml);
	hljs.registerLanguage("yaml", yaml);

	// Normalize common aliases to their canonical highlight.js language names.
	// The canonical name is what we'll attempt to dynamically import.
	const ALIASES: Record<string, string> = {
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		ts: "typescript",
		tsx: "typescript",
		py: "python",
		py3: "python",
		rb: "ruby",
		sh: "bash",
		shell: "bash",
		zsh: "bash",
		yml: "yaml",
		"c++": "cpp",
		cxx: "cpp",
		"c#": "csharp",
		cs: "csharp",
		htm: "xml",
		html: "xml",
		svg: "xml",
		md: "markdown",
		mdx: "markdown",
		dockerfile: "dockerfile",
		golang: "go",
		rs: "rust",
		kt: "kotlin",
		ps1: "powershell",
	};

	function normalizeLang(lang: string): string {
		const lower = lang.toLowerCase().trim();
		return ALIASES[lower] ?? lower;
	}

	const loadCache = new Map<string, Promise<boolean>>();

	async function ensureLanguage(lang: string): Promise<boolean> {
		const name = normalizeLang(lang);
		if (hljs.getLanguage(name)) return true;
		if (loadCache.has(name)) return loadCache.get(name)!;

		const promise = (async () => {
			try {
				// Vite resolves this template literal at build time into a glob
				// over all matching language modules, so each is a separate chunk.
				const mod = await import(`highlight.js/lib/languages/${name}`);
				hljs.registerLanguage(name, mod.default);
				return true;
			} catch {
				return false;
			}
		})();

		loadCache.set(name, promise);
		return promise;
	}

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	const md = new Marked(
		markedHighlight({
			emptyLangClass: "hljs",
			langPrefix: "hljs language-",
			async: true,
			async highlight(code: string, lang: string): Promise<string> {
				if (!lang) return escapeHtml(code);
				const name = normalizeLang(lang);
				const loaded = await ensureLanguage(name);
				if (!loaded) return escapeHtml(code);
				try {
					return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
				} catch {
					return escapeHtml(code);
				}
			},
		}),
		{
			gfm: true,
			breaks: true,
		},
	);

	const { text = "", streaming = false }: { text?: string; streaming?: boolean } = $props();

	function closeOpenDelimiters(src: string): string {
		let out = src;
		const fenceCount = (out.match(/^```/gm) || []).length;
		if (fenceCount % 2 !== 0) out += "\n```";
		const boldCount = (out.match(/\*\*/g) || []).length;
		if (boldCount % 2 !== 0) out += "**";
		const inlineCode = (out.match(/(?<!`)`(?!`)/g) || []).length;
		if (inlineCode % 2 !== 0) out += "`";
		return out;
	}

	let html = $state("");
	let renderToken = 0;

	$effect(() => {
		const src = streaming ? closeOpenDelimiters(text) : text;
		const myToken = ++renderToken;
		(async () => {
			try {
				const result = (await md.parse(src)) as string;
				if (myToken === renderToken) html = result;
			} catch {
				// swallow — keeps last successful render visible
			}
		})();
	});
</script>

<div class="markdown-body">
	{@html html}
</div>
