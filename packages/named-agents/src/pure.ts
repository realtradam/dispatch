/**
 * Pure core for the Named Agent registry — zero I/O, zero ambient state.
 *
 * Every function is input → output and tests without mocks. Normalization,
 * validation, duplicate detection, and record (de)serialization live here; the
 * storage-backed shell (./registry.ts) calls these and owns persistence.
 *
 * The persisted record is the wire `NamedAgent` (`{ id, name, model }`). It
 * carries NO secrets (a name + a provider/model identifier are user-visible
 * configuration, not credentials) and NO timestamps, so the core has no
 * redaction concern and no clock dependency.
 */
import type { NamedAgent } from "@dispatch/wire";

/** Prefix for a record key in the `named-agents` storage namespace. */
export const RECORD_KEY_PREFIX = "named-agent:";

/** Build the storage key for one Named Agent record. Pure. */
export function recordKey(id: string): string {
  return `${RECORD_KEY_PREFIX}${id}`;
}

/** Full-replace input shared by create and update. */
export interface NamedAgentInput {
  readonly name: string;
  readonly model: string;
}

// ─── Result types (typed success/error discriminated unions) ────────────────

/** A successful create: the canonical saved record. */
export interface CreateSuccess {
  readonly ok: true;
  readonly agent: NamedAgent;
}

/** A failed create: a typed validation/conflict error. */
export interface CreateError {
  readonly ok: false;
  readonly error: "duplicate-name" | "invalid-name" | "invalid-model";
}

export type CreateResult = CreateSuccess | CreateError;

/** A successful update: the canonical saved record. */
export interface UpdateSuccess {
  readonly ok: true;
  readonly agent: NamedAgent;
}

/** A failed update: not-found, or a typed validation/conflict error. */
export interface UpdateError {
  readonly ok: false;
  readonly error: "not-found" | "duplicate-name" | "invalid-name" | "invalid-model";
}

export type UpdateResult = UpdateSuccess | UpdateError;

/** A successful delete. */
export interface DeleteSuccess {
  readonly ok: true;
  readonly id: string;
}

/** A failed delete: the id did not match a record. */
export interface DeleteError {
  readonly ok: false;
  readonly error: "not-found";
  readonly id: string;
}

export type DeleteResult = DeleteSuccess | DeleteError;

// ─── Normalization & validation (pure) ──────────────────────────────────────

/**
 * Normalize a name: trim and collapse internal runs of whitespace to a single
 * space. This is the canonical form stored on a record and the form compared
 * for case-insensitive uniqueness.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** A name is valid when it is non-empty after trimming. */
export function isValidName(name: string): boolean {
  return name.trim().length > 0;
}

/**
 * A canonical model identifier is syntactically valid when it contains at least
 * one "/", both sides of the FIRST "/" are non-empty, and there is no leading
 * or trailing whitespace (plan §9 validation). `model` is the canonical
 * `<provider-or-credential>/<model>` value a raw-model caller passes to summon.
 */
export function isValidCanonicalModel(model: string): boolean {
  if (model.length === 0 || model !== model.trim()) return false;
  const slash = model.indexOf("/");
  if (slash === -1) return false;
  const provider = model.slice(0, slash);
  const modelName = model.slice(slash + 1);
  return provider.length > 0 && modelName.length > 0;
}

/**
 * True when `name` collides case-insensitively (after normalization) with any
 * existing record's name. The caller excludes the record being renamed before
 * calling, so this is the raw "does the name appear in the set" check.
 */
export function isDuplicateName(existing: readonly NamedAgent[], name: string): boolean {
  const target = normalizeName(name).toLowerCase();
  return existing.some((agent) => normalizeName(agent.name).toLowerCase() === target);
}

// ─── Record (de)serialization (pure) ────────────────────────────────────────

/** Serialize a Named Agent record to its persisted JSON form. Pure. */
export function serializeRecord(agent: NamedAgent): string {
  return JSON.stringify(agent);
}

/** Parse a stored JSON record; null if malformed or not a `NamedAgent` shape. */
export function parseRecord(raw: string): NamedAgent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isNamedAgent(value) ? value : null;
}

function isNamedAgent(value: unknown): value is NamedAgent {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === "string" && typeof rec.name === "string" && typeof rec.model === "string"
  );
}
