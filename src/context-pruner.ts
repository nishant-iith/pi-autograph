import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalGraphConfig } from "./types.ts";

const MARKER = "[PI_AUTOGRAPH_SPILL:";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

function safeToolName(value: unknown): string {
  return String(value ?? "tool").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 60) || "tool";
}

function spill(cwd: string, toolName: string, text: string): string {
  const dir = path.join(cwd, ".pi", "goal-graph", "context-spill");
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const file = path.join(dir, `${safeToolName(toolName)}-${hash}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, "utf8");
  return path.relative(cwd, file).replaceAll("\\", "/");
}

function preview(text: string, file: string, maxInline: number): string {
  const head = Math.max(900, Math.floor(maxInline * 0.64));
  const tail = Math.max(500, maxInline - head);
  const omitted = Math.max(0, text.length - head - tail);
  return `${text.slice(0, head)}\n\n[PI_AUTOGRAPH_SPILL:${file}]\n[${omitted.toLocaleString()} characters omitted from active context; full raw output is recoverable at the path above.]\n\n${text.slice(-tail)}`;
}

function thresholdFor(percent: number | null | undefined, config: GoalGraphConfig): { pruneAbove: number; inline: number } {
  // The percentages are operational policy knobs, not claims about a universal model-quality boundary.
  if (percent != null && percent >= config.context.hardCompactAtPct) return { pruneAbove: 4_000, inline: 3_000 };
  if (percent != null && percent >= config.context.pruneAtPct) return { pruneAbove: 8_000, inline: 5_000 };
  if (percent != null && percent >= config.context.softTargetPct) return { pruneAbove: 12_000, inline: 7_000 };
  return { pruneAbove: 50_000, inline: 9_000 };
}

export interface PruneStats {
  prunedMessages: number;
  spilledChars: number;
  percent: number | null;
}

/**
 * Ephemerally shrink oversized tool results before a child worker's next provider call.
 * Raw transcript history is untouched; the complete text is spilled to disk first.
 */
export function pruneToolContext(
  cwd: string,
  messages: any[],
  config: GoalGraphConfig,
  contextPercent?: number | null,
): { messages: any[]; stats: PruneStats } {
  const { pruneAbove, inline } = thresholdFor(contextPercent, config);
  let prunedMessages = 0;
  let spilledChars = 0;

  const next = messages.map((message) => {
    if (message?.role !== "toolResult") return message;
    const text = messageText(message.content);
    if (!text || text.includes(MARKER) || text.length <= pruneAbove) return message;

    try {
      const file = spill(cwd, message.toolName, text);
      const replacement = preview(text, file, inline);
      const nonText = Array.isArray(message.content)
        ? message.content.filter((p: any) => p?.type !== "text")
        : [];
      prunedMessages += 1;
      spilledChars += text.length;
      return {
        ...message,
        content: [{ type: "text", text: replacement }, ...nonText],
      };
    } catch {
      // Context transforms should fail open: never break a worker because archiving failed.
      return message;
    }
  });

  return { messages: next, stats: { prunedMessages, spilledChars, percent: contextPercent ?? null } };
}
