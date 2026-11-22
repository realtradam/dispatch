// @dispatch/discord-bridge — relays Discord chat threads (through the Felicity
// bot's agent API) with existing Dispatch conversations, both ways.

export {
  attributionLine,
  Bridge,
  type BridgeDeps,
  type BridgeOrchestrator,
  type BridgeStore,
  type ConversationRefResolution,
  promptFromMessage,
  resolveConversationRef,
} from "./bridge.js";
export {
  type BindInput,
  type BindResult,
  type Chat,
  type ChatAuthor,
  type ChatEvent,
  createRestClient,
  type FelicityClient,
  FelicityError,
} from "./client.js";
export {
  type BridgeConfig,
  createDiscordBridgeExtension,
  type DiscordBridgeOptions,
  extension,
  FELICITY_API_TOKEN,
  FELICITY_API_URL,
  manifest,
  readConfig,
  systemClock,
} from "./extension.js";
export {
  formatStepFooter,
  formatTurnSummary,
  middleTruncate,
  splitMessage,
} from "./format.js";
export { type RelayEvent, RelayFormatter, type UpsertOp } from "./formatter.js";
export {
  clampReplayCount,
  DEFAULT_REPLAY_COUNT,
  historyToEvents,
  MAX_REPLAY_COUNT,
  planReplay,
  renderMessages,
} from "./replay.js";
export { type Clock, ThreadSender } from "./sender.js";
