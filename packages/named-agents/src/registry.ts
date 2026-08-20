/**
 * Named Agent registry service — the typed handle both `agent-management`
 * (list/summon) and `transport-http` (CRUD routes) obtain to read/write the
 * user-curated Named Agent registry.
 *
 * Pure decision logic (normalize/validate/duplicate/serialize) lives in
 * ./pure.ts; this shell owns the storage namespace + the id factory. State is
 * owned (not ambient): the `storage` reference + `deps` live in this closure,
 * reachable only through the returned service.
 *
 * The registry NEVER imports `credential-store` and never calls
 * `listCatalog` / `getModelInfo` — listing and named-agent summon perform ZERO
 * provider-catalog calls (plan §10.2, §14). `NamedAgentsDeps` deliberately
 * exposes only an id factory (+ reserved clock); it has no catalog handle.
 */
import { defineService, type ServiceHandle, type StorageNamespace } from "@dispatch/kernel";
import type { NamedAgent } from "@dispatch/wire";
import {
  type CreateResult,
  type DeleteResult,
  isDuplicateName,
  isValidCanonicalModel,
  isValidName,
  type NamedAgentInput,
  normalizeName,
  parseRecord,
  RECORD_KEY_PREFIX,
  recordKey,
  serializeRecord,
  type UpdateResult,
} from "./pure.js";

/**
 * The Named Agent registry service. Obtained via
 * `host.getService(namedAgentServiceHandle)`.
 *
 * One JSON record per stable id lives in the `named-agents` storage namespace
 * under `named-agent:<id>`; `list` reads `keys()` + parses, and create/update/
 * delete target a single key. Case-insensitive uniqueness is enforced by
 * scanning the (small) set — no secondary index.
 */
export interface NamedAgentsService {
  /** All records, in deterministic case-insensitive name order. */
  list(): Promise<readonly NamedAgent[]>;

  /** Look up a record by stable id, or null if none. */
  get(id: string): Promise<NamedAgent | null>;

  /** Look up a record by case-insensitive normalized name, or null if none. */
  getByName(name: string): Promise<NamedAgent | null>;

  /**
   * Create a record: generate a stable id, trim/normalize the name, validate
   * the name + model, enforce case-insensitive uniqueness, persist, and return
   * the canonical saved record. Returns a typed error on duplicate-name /
   * invalid-name / invalid-model.
   */
  create(input: NamedAgentInput): Promise<CreateResult>;

  /**
   * Full update by stable id: validate + enforce uniqueness (excluding self on
   * a rename), persist, and return the canonical saved record. Returns a typed
   * not-found error for an unknown id.
   */
  update(id: string, input: NamedAgentInput): Promise<UpdateResult>;

  /** Remove a record by stable id. Returns a typed not-found error for an unknown id. */
  delete(id: string): Promise<DeleteResult>;

  /**
   * Resolve a summon-side reference by stable id OR normalized (case-
   * insensitive) name — id first, then name. Null if neither matches. This is
   * the lookup `summon_agent` uses to turn a Named Agent reference into its
   * configured raw model without any catalog call.
   */
  resolve(ref: string): Promise<NamedAgent | null>;
}

/**
 * Typed handle anchoring the registry service — the single symbol consumers
 * import to reach the registry. No string-keyed lookup.
 */
export const namedAgentServiceHandle: ServiceHandle<NamedAgentsService> =
  defineService<NamedAgentsService>("named-agents/service");

/**
 * Injected effectful factories kept out of the pure core. There is NO
 * credential-store / catalog handle here by design (plan §10.2): the registry
 * is a local user-config store, not a provider-discovery path.
 */
export interface NamedAgentsDeps {
  /** Stable id factory (default: `crypto.randomUUID`). */
  readonly generateId?: () => string;
  /**
   * Clock (epoch-ms) if timestamps are kept. The current `NamedAgent` record
   * carries no timestamps, so this is reserved for future use and unused today.
   */
  readonly now?: () => number;
}

/** Find a record by case-insensitive normalized name within an in-memory set. */
function findByName(all: readonly NamedAgent[], name: string): NamedAgent | null {
  const target = normalizeName(name).toLowerCase();
  return all.find((agent) => normalizeName(agent.name).toLowerCase() === target) ?? null;
}

/**
 * Create a `NamedAgentsService` backed by a storage namespace + injected id
 * factory. Pure-ish: effects (`StorageNamespace`, `generateId`) are injected,
 * so the service tests with an in-memory storage fake and a deterministic id
 * factory. Empty registry requires NO seeding and NO catalog calls.
 */
export function createNamedAgentsService(
  storage: StorageNamespace,
  deps: NamedAgentsDeps = {},
): NamedAgentsService {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());

  /** Read every record; deterministic case-insensitive name order, then id. */
  async function readAll(): Promise<NamedAgent[]> {
    const keys = await storage.keys(RECORD_KEY_PREFIX);
    const records: NamedAgent[] = [];
    for (const key of keys) {
      const raw = await storage.get(key);
      if (raw === null) continue;
      const parsed = parseRecord(raw);
      if (parsed !== null) records.push(parsed);
    }
    // Deterministic, friendly order for the frontend sidebar and
    // GET /named-agents. Names are unique, so the id tiebreak never fires.
    records.sort(
      (a, b) =>
        normalizeName(a.name).toLowerCase().localeCompare(normalizeName(b.name).toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
    return records;
  }

  return {
    async list() {
      return readAll();
    },

    async get(id) {
      const raw = await storage.get(recordKey(id));
      if (raw === null) return null;
      return parseRecord(raw);
    },

    async getByName(name) {
      return findByName(await readAll(), name);
    },

    async create(input) {
      if (!isValidName(input.name)) return { ok: false, error: "invalid-name" };
      if (!isValidCanonicalModel(input.model)) return { ok: false, error: "invalid-model" };
      const existing = await readAll();
      if (isDuplicateName(existing, input.name)) return { ok: false, error: "duplicate-name" };
      const agent: NamedAgent = {
        id: generateId(),
        name: normalizeName(input.name),
        model: input.model,
      };
      await storage.set(recordKey(agent.id), serializeRecord(agent));
      return { ok: true, agent };
    },

    async update(id, input) {
      const current = await storage.get(recordKey(id));
      if (current === null) return { ok: false, error: "not-found" };
      if (!isValidName(input.name)) return { ok: false, error: "invalid-name" };
      if (!isValidCanonicalModel(input.model)) return { ok: false, error: "invalid-model" };
      const others = (await readAll()).filter((agent) => agent.id !== id);
      if (isDuplicateName(others, input.name)) return { ok: false, error: "duplicate-name" };
      const updated: NamedAgent = {
        id,
        name: normalizeName(input.name),
        model: input.model,
      };
      await storage.set(recordKey(id), serializeRecord(updated));
      return { ok: true, agent: updated };
    },

    async delete(id) {
      const key = recordKey(id);
      if (!(await storage.has(key))) return { ok: false, error: "not-found", id };
      await storage.delete(key);
      return { ok: true, id };
    },

    async resolve(ref) {
      // Id first: a stable id is the unambiguous target. If no record is stored
      // under `named-agent:<ref>`, fall back to a case-insensitive name match.
      const raw = await storage.get(recordKey(ref));
      if (raw !== null) {
        const parsed = parseRecord(raw);
        if (parsed !== null) return parsed;
      }
      return findByName(await readAll(), ref);
    },
  };
}
