export type {
	CreateOpenAICompatProviderOpts,
	OpenAIMessage,
	OpenAITool,
	OpenAIToolCall,
} from "@dispatch/openai-stream";
export {
	convertMessages,
	convertTools,
	createOpenAICompatProvider,
	parseModelList,
	parseSSELines,
} from "@dispatch/openai-stream";
export { activate, extension, manifest } from "./extension.js";
