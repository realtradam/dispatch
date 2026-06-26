/**
 * Hooks and services — typed cross-extension coupling anchors.
 *
 * Every cross-extension reference is anchored to an exported typed symbol
 * (not a raw string), so `lsp references` can compute the true blast radius
 * of a change. The id string lives in exactly one place: the owner's
 * `defineHook` / `defineFilter` / `defineService` declaration.
 *
 * Two hook kinds:
 * - **Event**: fire-and-forget, N listeners, error-isolated per handler.
 * - **Filter**: ordered value-in→value-out chain, in-band, awaited.
 *
 * Services are NOT hooks — they are single-responder request/response.
 */

/**
 * A typed descriptor for an event hook. The id string is the single source
 * of truth; consumers import this symbol, never the raw string.
 *
 * Event hooks are fire-and-forget: N listeners, errors isolated per handler
 * (a thrown handler is caught and logged — it never breaks the turn).
 */
export interface EventHookDescriptor<TPayload> {
  readonly kind: "event";
  readonly id: string;
  readonly _payload?: TPayload;
}

/**
 * A typed descriptor for a filter hook. Filters are an ordered chain:
 * each receives the current value and returns the (possibly transformed)
 * next value. Awaited in-band — a slow filter slows the turn, by design.
 *
 * Fail-open by default (a thrown filter logs and passes the value through);
 * the owner may mark a chain fail-closed.
 */
export interface FilterDescriptor<TValue> {
  readonly kind: "filter";
  readonly id: string;
  readonly _value?: TValue;
}

/** Union of hook descriptor kinds the kernel mechanism supports. */
export type HookDescriptor<TPayload> = EventHookDescriptor<TPayload> | FilterDescriptor<TPayload>;

/**
 * A typed service handle. Services are single-responder request/response —
 * NOT hooks. Modeling "ask the human for permission" as a hook invites
 * "which of N handlers wins?" ambiguity; a service has exactly one provider.
 */
export interface ServiceHandle<T> {
  readonly kind: "service";
  readonly id: string;
  readonly _type?: T;
}

/**
 * Create a typed event hook descriptor. Pure function, no side effects.
 * The returned object is the symbol consumers import and pass to `host.on`.
 *
 * @param id - Namespaced hook id in `owner/name` form (e.g. "kernel/turn.sealed").
 */
export function defineEventHook<TPayload>(id: string): EventHookDescriptor<TPayload> {
  return { kind: "event", id };
}

/**
 * Create a typed filter hook descriptor. Pure function, no side effects.
 * The returned object is the symbol consumers import and pass to `host.addFilter`.
 *
 * @param id - Namespaced filter id in `owner/name` form.
 */
export function defineFilter<TValue>(id: string): FilterDescriptor<TValue> {
  return { kind: "filter", id };
}

/**
 * Create a typed service handle. Pure function, no side effects.
 * The returned object is the symbol a provider passes to `host.provideService`
 * and consumers pass to `host.getService`.
 *
 * @param id - Namespaced service id in `owner/name` form.
 */
export function defineService<T>(id: string): ServiceHandle<T> {
  return { kind: "service", id };
}

/** Handler function for an event hook subscription. */
export type EventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;

/** Transform function for a filter hook in the chain. */
export type FilterHandler<TValue> = (value: TValue) => TValue | Promise<TValue>;
