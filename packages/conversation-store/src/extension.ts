import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { initializeConversationListIndex } from "./list-index.js";
import { conversationDeleted, conversationStoreHandle, createConversationStore } from "./store.js";

export const manifest: Manifest = {
  id: "conversation-store",
  name: "Conversation Store",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
  capabilities: { db: true },
  contributes: {
    services: ["conversation-store/store"],
    hooks: [conversationDeleted.id],
  },
  activation: "eager",
};

export const extension: Extension = {
  manifest,
  activate: async (host: HostAPI) => {
    const storage = host.storage("conversation-store");
    const store = createConversationStore(
      storage,
      host.logger,
      undefined,
      process.cwd(),
      (payload) => host.emit(conversationDeleted, payload),
    );

    // One-time persisted-state migration: rewrite obsolete numbered
    // `opencode-<n>/<model>` per-conversation model values to the single
    // `opencode/<model>` namespace. Idempotent (only touches numbered-prefixed
    // values), so a re-run is a no-op. Runtime code understands ONLY the
    // unnumbered name; no alias is retained.
    const migrated = await store.migrateLegacyOpenCodeModels();
    if (migrated > 0) {
      host.logger.info(
        `conversation-store: migrated ${migrated} legacy "opencode-<n>/" model selection(s) → "opencode/"`,
      );
    }

    // One-time persisted-state migration: legacy image-transcription caches
    // were one giant JSON blob per conversation keyed by full (resolved) image
    // data URLs. Convert each to one small row per image keyed by
    // sha256(persisted URL), then delete the blob. Idempotent — a second run
    // finds no legacy keys. Errors are contained: boot must not fail.
    try {
      const imageMigration = await store.migrateImageTranscriptions();
      if (imageMigration.blobs > 0 || imageMigration.skipped > 0) {
        host.logger.info("conversation-store: image-transcription cache migration", {
          blobs: imageMigration.blobs,
          migrated: imageMigration.migrated,
          skipped: imageMigration.skipped,
        });
      }
    } catch (err) {
      host.logger.warn("conversation-store: image-transcription migration failed (continuing)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await initializeConversationListIndex(storage);

    const stale = await store.listConversations({ status: ["active"] });
    for (const m of stale) {
      await store.setConversationStatus(m.id, "idle");
    }
    if (stale.length > 0) {
      host.logger.info("conversation-store: boot-sweep", { resetCount: stale.length });
    }

    host.provideService(conversationStoreHandle, store);
  },
};
