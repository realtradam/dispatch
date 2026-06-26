/**
 * Watched-files registration state machine + glob matcher.
 *
 * Manages `workspace/didChangeWatchedFiles` registrations from the server.
 * `applyRegister` stores watchers, `applyUnregister` removes them, and
 * `matches(path)` tests a file path against all registered glob patterns.
 *
 * Glob matching supports double-star (any path segments), star (within a segment),
 * and literals.
 */

export interface FileSystemWatcher {
  readonly globPattern: string;
  readonly kind?: number;
}

export interface DidChangeWatchedFilesRegistrationOptions {
  readonly watchers: readonly FileSystemWatcher[];
}

export interface Registration {
  readonly id: string;
  readonly method: string;
  readonly registerOptions?: DidChangeWatchedFilesRegistrationOptions;
}

export const FileChangeType = {
  Created: 1,
  Changed: 2,
  Deleted: 3,
} as const;

export type FileChangeTypeValue = (typeof FileChangeType)[keyof typeof FileChangeType];

export class WatchedFilesRegistry {
  private watchers = new Map<string, readonly FileSystemWatcher[]>();

  applyRegister(registration: Registration): void {
    if (registration.method !== "workspace/didChangeWatchedFiles") return;
    const opts = registration.registerOptions;
    if (!opts?.watchers) return;
    this.watchers.set(registration.id, opts.watchers);
  }

  applyUnregister(unregistration: { readonly id: string; readonly method: string }): void {
    if (unregistration.method !== "workspace/didChangeWatchedFiles") return;
    this.watchers.delete(unregistration.id);
  }

  matches(filePath: string): boolean {
    for (const watchers of this.watchers.values()) {
      for (const w of watchers) {
        if (globMatch(w.globPattern, filePath)) return true;
      }
    }
    return false;
  }

  getAllWatchers(): readonly FileSystemWatcher[] {
    const result: FileSystemWatcher[] = [];
    for (const watchers of this.watchers.values()) {
      for (const w of watchers) {
        result.push(w);
      }
    }
    return result;
  }
}

export function globMatch(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/^\/+/, "").replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/^\/+/, "").replace(/\\/g, "/");
  const regex = globToRegex(normalizedPattern);
  return regex.test(normalizedPath);
}

function globToRegex(glob: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        regex += "(?:.+/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === ".") {
      regex += "\\.";
      i++;
    } else {
      regex += escapeRegex(ch);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
