/** Public barrel for `@dispatch/window-keeper`. */
export { activate, deactivate, extension, manifest } from "./extension.js";
export {
  createWindowKeeper,
  type KickOutcome,
  type WindowKeeper,
  type WindowKeeperDeps,
} from "./keeper.js";
export {
  CLAUDE_PROFILE,
  CODEX_PROFILE,
  KEEPER_PROFILES,
  type KeeperProfile,
  type KeeperProviderId,
} from "./profiles.js";
export * from "./settings.js";
