<script lang="ts">
	import { Marked } from "marked";
	import { markedHighlight } from "marked-highlight";
	import hljs from "highlight.js/lib/core";
	import bash from "highlight.js/lib/languages/bash";
	import javascript from "highlight.js/lib/languages/javascript";
	import json from "highlight.js/lib/languages/json";
	import python from "highlight.js/lib/languages/python";
	import typescript from "highlight.js/lib/languages/typescript";

	hljs.registerLanguage("bash", bash);
	hljs.registerLanguage("sh", bash);
	hljs.registerLanguage("shell", bash);
	hljs.registerLanguage("javascript", javascript);
	hljs.registerLanguage("js", javascript);
	hljs.registerLanguage("json", json);
	hljs.registerLanguage("python", python);
	hljs.registerLanguage("py", python);
	hljs.registerLanguage("typescript", typescript);
	hljs.registerLanguage("ts", typescript);

	const md = new Marked(
		markedHighlight({
			emptyLangClass: "hljs",
			langPrefix: "hljs language-",
			highlight(code: string, lang: string) {
				const language = hljs.getLanguage(lang) ? lang : "plaintext";
				return hljs.highlight(code, { language, ignoreIllegals: true }).value;
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

	const html = $derived.by(() => {
		const src = streaming ? closeOpenDelimiters(text) : text;
		return md.parse(src) as string;
	});
</script>

<div class="markdown-body">
	{@html html}
</div>
