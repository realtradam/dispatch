/**
 * @dispatch/named-agents — the extension that owns the user-curated Named Agent
 * registry (a friendly name → provider/model preset used by agent summoning and
 * the frontend model selector). See notes/named-agents-plan.md.
 *
 * Consumers (`agent-management` list/summon, `transport-http` CRUD routes) reach
 * the registry through the typed `namedAgentServiceHandle`, never by string.
 */

export type { NamedAgent, NamedAgentSelectionSnapshot } from "@dispatch/wire";
export { extension, manifest } from "./extension.js";
export {
  type CreateError,
  type CreateResult,
  type CreateSuccess,
  type DeleteError,
  type DeleteResult,
  type DeleteSuccess,
  isDuplicateName,
  isValidCanonicalModel,
  isValidName,
  type NamedAgentInput,
  normalizeName,
  parseRecord,
  RECORD_KEY_PREFIX,
  recordKey,
  serializeRecord,
  type UpdateError,
  type UpdateResult,
  type UpdateSuccess,
} from "./pure.js";
export {
  createNamedAgentsService,
  type NamedAgentsDeps,
  type NamedAgentsService,
  namedAgentServiceHandle,
} from "./registry.js";
