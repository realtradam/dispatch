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
export { activate, extension, manifest, OPENCODE_CREDENTIAL_CONFIG_KEY } from "./extension.js";
export {
  DEFAULT_OPENCODE_BASE_URL,
  DEFAULT_OPENCODE_MODEL,
  formatOpenCodeEnvDiagnostics,
  hasOpenCodeCredential,
  isFatalOpenCodeEnvDiagnostic,
  LEGACY_NUMBERED_OPENCODE_API_KEY_PREFIX,
  OPENCODE_API_KEY_VAR,
  OPENCODE_PROVIDER_ID,
  type OpenCodeCredential,
  type OpenCodeEnvDiagnostic,
  type ParseOpenCodeEnvResult,
  parseOpenCodeEnv,
} from "./opencode-config.js";
