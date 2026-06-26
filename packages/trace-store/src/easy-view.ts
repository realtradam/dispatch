import type { Attributes, LogRecord } from "@dispatch/kernel";

interface SpanInfo {
  name: string;
  openTimestamp: number;
  closeTimestamp?: number;
  durationMs?: number;
  status?: string;
  body?: string;
  attributes?: Attributes;
  children: TimelineEntry[];
}

interface LogEntry {
  record: LogRecord;
}

type TimelineEntry = { type: "span"; span: SpanInfo } | { type: "log"; entry: LogEntry };

export function renderEasyView(records: readonly LogRecord[]): string {
  if (records.length === 0) {
    return "";
  }

  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);

  const spansById = new Map<string, SpanInfo>();
  const roots: TimelineEntry[] = [];
  const childrenByParent = new Map<string | undefined, TimelineEntry[]>();

  for (const r of sorted) {
    if (r.kind === "span-open") {
      const span: SpanInfo = {
        name: r.name,
        openTimestamp: r.timestamp,
        ...(r.body !== undefined && { body: r.body }),
        ...(r.attributes !== undefined && { attributes: r.attributes }),
        children: [],
      };
      spansById.set(r.spanId, span);
    } else if (r.kind === "span-close") {
      const span = spansById.get(r.spanId);
      if (span !== undefined) {
        span.closeTimestamp = r.timestamp;
        span.durationMs = r.durationMs;
        span.status = r.status;
        if (r.body !== undefined) {
          span.body = r.body;
        }
        if (r.attributes !== undefined) {
          span.attributes = { ...span.attributes, ...r.attributes };
        }
      }
    } else {
      const entry: TimelineEntry = { type: "log", entry: { record: r } };
      const parentId = r.parentSpanId;
      let siblings = childrenByParent.get(parentId);
      if (siblings === undefined) {
        siblings = [];
        childrenByParent.set(parentId, siblings);
      }
      siblings.push(entry);
    }
  }

  for (const [spanId, span] of spansById) {
    const entry: TimelineEntry = { type: "span", span };
    const parentId = getSpanParentId(sorted, spanId);
    let siblings = childrenByParent.get(parentId);
    if (siblings === undefined) {
      siblings = [];
      childrenByParent.set(parentId, siblings);
    }
    siblings.push(entry);
  }

  for (const [parentId, children] of childrenByParent) {
    if (parentId === undefined) {
      roots.push(...children);
    } else {
      const parent = spansById.get(parentId);
      if (parent !== undefined) {
        parent.children.push(...children);
      } else {
        roots.push(...children);
      }
    }
  }

  sortByTimestamp(roots);
  for (const entry of roots) {
    if (entry.type === "span") {
      sortByTimestamp(entry.span.children);
    }
  }

  const lines: string[] = [];
  for (const entry of roots) {
    renderEntry(entry, 0, lines);
  }
  return lines.join("\n");
}

function sortByTimestamp(entries: TimelineEntry[]): void {
  entries.sort((a, b) => {
    const tsA = a.type === "span" ? a.span.openTimestamp : a.entry.record.timestamp;
    const tsB = b.type === "span" ? b.span.openTimestamp : b.entry.record.timestamp;
    return tsA - tsB;
  });
}

function getSpanParentId(records: readonly LogRecord[], spanId: string): string | undefined {
  for (const r of records) {
    if (r.kind === "span-open" && r.spanId === spanId) {
      return r.parentSpanId;
    }
  }
  return undefined;
}

function renderEntry(entry: TimelineEntry, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);

  if (entry.type === "span") {
    const span = entry.span;
    const dur = span.durationMs !== undefined ? formatDuration(span.durationMs) : undefined;
    const statusStr = span.status === "error" ? " ERR" : "";
    const suffix = dur !== undefined ? ` ${dur}${statusStr}` : " (open)";

    let detail = "";
    if (span.attributes !== undefined) {
      const keys = Object.keys(span.attributes);
      if (keys.length > 0) {
        const parts: string[] = [];
        for (const k of keys.slice(0, 3)) {
          const v = span.attributes[k];
          if (v !== undefined) {
            parts.push(`${k}=${formatAttrValue(v)}`);
          }
        }
        detail = ` {${parts.join(", ")}}`;
      }
    }

    const bodyHint = span.body !== undefined ? ` [body ${formatSize(span.body.length)}]` : "";

    lines.push(`${indent}- ${span.name}${suffix}${detail}${bodyHint}`);

    for (const child of span.children) {
      renderEntry(child, depth + 1, lines);
    }
  } else {
    const r = entry.entry.record;
    if (r.kind === "log") {
      const lvl = levelTag(r.level);
      const bodyHint = r.body !== undefined ? ` [body ${formatSize(r.body.length)}]` : "";
      lines.push(`${indent}- ${lvl}${r.msg}${bodyHint}`);
    }
  }
}

function levelTag(level: string): string {
  if (level === "info") {
    return "";
  }
  return `[${level}] `;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m${rem}s`;
}

function formatSize(n: number): string {
  if (n < 1024) {
    return `${n}b`;
  }
  const kb = n / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)}k`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)}M`;
}

function formatAttrValue(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    if (value.length > 20) {
      return `"${value.slice(0, 17)}..."`;
    }
    return `"${value}"`;
  }
  return String(value);
}
