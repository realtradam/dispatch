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
export { activate, extension, manifest, OPENCODE_CREDENTIALS_CONFIG_KEY } from "./extension.js";
export {
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_MODEL,
  hasNumberedOpenCodeCredentials,
  OPENCODE_API_KEY_PREFIX,
  type OpenCodeEnvDiagnostic,
  type OpenCodeNumberedCredential,
  type ParseNumberedOpenCodeEnvResult,
  parseNumberedOpenCodeEnv,
} from "./opencode-config.js";
