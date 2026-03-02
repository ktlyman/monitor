import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  Learning,
  LearningCategory,
  Session,
  SessionMessage,
  ToolInvocation,
  ThinkingBlock,
  SessionAnalytics,
  ApiRequest,
  SubagentRun,
} from "../types/index.js";

/** Result of deep-extracting a session JSONL file. */
export interface DeepExtractionResult {
  messages: SessionMessage[];
  toolInvocations: ToolInvocation[];
  thinkingBlocks: ThinkingBlock[];
  apiRequests: ApiRequest[];
  analytics: SessionAnalytics;
  parseErrors: number;
}

/** Per-model pricing in USD per million tokens. */
interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":           { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5  },
  "claude-sonnet-4-6":         { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.3  },
  "claude-sonnet-4-20250514":  { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.3  },
  "claude-haiku-4-5-20251001": { input: 1, output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2,  cacheRead: 0.10 },
};

/** Default pricing (Opus 4.6) for unknown models. */
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-opus-4-6"];

function getPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  // Try exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Try prefix match (e.g. "claude-opus-4-6-20260101" → "claude-opus-4-6")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

/**
 * Cost estimation caveat: costs are aggregated per session from assistant message
 * token counts, not per API request. Actual billing may differ due to per-request
 * cache slot computation and long-context premiums (>200K input tokens).
 * For billing-grade accuracy, a per-request costing table would be needed.
 */

/** Maximum character length for stored message content. */
const MAX_MESSAGE_CONTENT_LENGTH = 10_000;

/** Extract text content from an array of content blocks, truncating to limit. */
function extractContentText(contentBlocks: Record<string, unknown>[]): string | null {
  if (contentBlocks.length === 0) return null;

  const parts: string[] = [];
  for (const block of contentBlocks) {
    const blockType = block.type as string;
    if (blockType === "text") {
      const text = (block.text as string) ?? "";
      if (text) parts.push(text);
    } else if (blockType === "tool_result") {
      const content = block.content;
      if (typeof content === "string") {
        parts.push(`[tool_result: ${content.slice(0, 200)}]`);
      } else if (Array.isArray(content)) {
        const textParts = (content as Record<string, unknown>[])
          .filter((b) => b.type === "text")
          .map((b) => ((b.text as string) ?? ""))
          .join(" ");
        if (textParts) {
          parts.push(`[tool_result: ${textParts.slice(0, 200)}]`);
        }
      }
    }
    // Skip tool_use (captured as ToolInvocation) and thinking (captured as ThinkingBlock)
  }

  if (parts.length === 0) return null;
  const combined = parts.join("\n");
  return combined.length > MAX_MESSAGE_CONTENT_LENGTH
    ? combined.slice(0, MAX_MESSAGE_CONTENT_LENGTH)
    : combined;
}

/**
 * Detect streaming fragments: consecutive assistant entries chained via parentUuid
 * share identical token usage (same API response). Returns true for non-root entries.
 */
function isStreamingFragment(
  entryType: string,
  parentUuid: string | null,
  lastAssistantUuid: string
): boolean {
  return entryType === "assistant"
    && parentUuid === lastAssistantUuid
    && lastAssistantUuid !== "";
}

/** Extract content from a user message entry (handles both string and array formats). */
function extractUserContent(entry: Record<string, unknown>): string | null {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (typeof content === "string") {
    return content.length > MAX_MESSAGE_CONTENT_LENGTH
      ? content.slice(0, MAX_MESSAGE_CONTENT_LENGTH)
      : content;
  }
  if (Array.isArray(content)) {
    return extractContentText(content as Record<string, unknown>[]);
  }
  return null;
}

/**
 * Extracts learnings from collected project data.
 * Parses JSONL sessions, MEMORY.md, CLAUDE.md, and rule files.
 */
export class LearningExtractor {
  /**
   * Parse a JSONL session file into a Session summary.
   * Uses streaming reads to handle large files safely.
   */
  async extractSessionMeta(
    jsonlPath: string,
    projectDirName: string
  ): Promise<Session> {
    let userCount = 0;
    let assistantCount = 0;
    let toolUseCount = 0;
    let firstTimestamp = "";
    let lastTimestamp = "";
    let sessionId = "";
    let lastAssistantUuid = "";

    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const ts = (entry.timestamp as string) ?? "";

        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;
        if (!sessionId && entry.sessionId)
          sessionId = entry.sessionId as string;

        const type = entry.type as string;
        if (type === "user") userCount++;
        if (type === "assistant") {
          const uuid = (entry.uuid as string) ?? "";
          const parentUuid = (entry.parentUuid as string) ?? "";
          if (!isStreamingFragment(type, parentUuid, lastAssistantUuid)) assistantCount++;
          lastAssistantUuid = uuid;
          // Count tool_use blocks from ALL entries (each fragment has unique blocks)
          const message = entry.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            toolUseCount += content.filter(
              (b: Record<string, unknown>) => b.type === "tool_use"
            ).length;
          }
        } else {
          lastAssistantUuid = "";
        }
      } catch {
        // Skip malformed lines — defensive parsing per scanner-trust rules
      }
    }

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(jsonlPath);

    return {
      sessionId: sessionId || jsonlPath,
      projectDirName,
      jsonlPath,
      startedAt: firstTimestamp,
      endedAt: lastTimestamp,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      toolUseCount,
      fileSizeBytes: fileStat.size,
    };
  }

  /** Extract learnings from a MEMORY.md file. */
  extractFromMemory(content: string, projectName: string, projectDirName: string): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
      projectDirName,
      sourceType: "memory" as const,
      sourcePath: "memory/MEMORY.md",
      content: section.trim(),
      category: this._categorize(section),
      extractedAt: new Date().toISOString(),
    }));
  }

  /** Extract learnings from a CLAUDE.md file. */
  extractFromClaudeMd(content: string, projectName: string, projectDirName: string): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
      projectDirName,
      sourceType: "claude_md" as const,
      sourcePath: "CLAUDE.md",
      content: section.trim(),
      category: this._categorize(section),
      extractedAt: new Date().toISOString(),
    }));
  }

  /** Extract learnings from .claude/rules/ files. */
  extractFromRules(
    files: Array<{ path: string; content: string }>,
    projectName: string,
    projectDirName: string
  ): Learning[] {
    const learnings: Learning[] = [];
    for (const file of files) {
      // Strip YAML frontmatter
      const content = file.content.replace(/^---[\s\S]*?---\n?/, "").trim();
      if (content) {
        learnings.push({
          projectName,
          projectDirName,
          sourceType: "rules" as const,
          sourcePath: `.claude/rules/${file.path}`,
          content,
          category: "convention",
          extractedAt: new Date().toISOString(),
        });
      }
    }
    return learnings;
  }

  /** Extract learnings from agent-lessons.md or agent-learnings.md. */
  extractFromAgentLessons(
    content: string,
    projectName: string,
    projectDirName: string
  ): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
      projectDirName,
      sourceType: "agent_lessons" as const,
      sourcePath: ".claude/agent-lessons.md",
      content: section.trim(),
      category: this._categorize(section),
      extractedAt: new Date().toISOString(),
    }));
  }

  /**
   * Deep-extract a session JSONL file into messages, tool invocations,
   * thinking blocks, and pre-computed analytics. Single streaming pass.
   * Skips `progress` and `queue-operation` entries (high volume, low value).
   */
  async extractSessionDeep(
    jsonlPath: string,
    sessionId: string
  ): Promise<DeepExtractionResult> {
    const messages: SessionMessage[] = [];
    const toolInvocations: ToolInvocation[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    const apiRequests: ApiRequest[] = [];

    // Map tool_use IDs to their invocations for error/lifecycle marking
    const toolMap = new Map<string, ToolInvocation>();

    // Analytics accumulators
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWrite5mTokens = 0;
    let totalCacheWrite1hTokens = 0;
    let apiRequestCount = 0;
    let errorCount = 0;
    let thinkingCharCount = 0;
    let estimatedCostAccum = 0;
    const toolCounts = new Map<string, number>();
    const modelSet = new Set<string>();
    let firstTimestamp = "";
    let lastTimestamp = "";
    let parseErrors = 0;

    let lastAssistantUuid = "";

    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const entryType = entry.type as string | undefined;

        // Skip high-volume, low-value entry types
        if (!entryType || entryType === "progress" || entryType === "queue-operation") {
          continue;
        }

        const ts = (entry.timestamp as string) ?? "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;

        // Only extract messages for user/assistant/system
        if (entryType === "user" || entryType === "assistant" || entryType === "system") {
          const message = entry.message as Record<string, unknown> | undefined;
          const content = message?.content;
          const contentBlocks = Array.isArray(content) ? content as Record<string, unknown>[] : [];

          // Extract usage from message (usage lives at message.usage, not entry.usage)
          const usage = (message?.usage as Record<string, unknown>) ??
            (entry.usage as Record<string, unknown> | undefined);
          const inputTokens = (usage?.input_tokens as number) ?? 0;
          const outputTokens = (usage?.output_tokens as number) ?? 0;
          const cacheCreationTokens = (usage?.cache_creation_input_tokens as number) ?? 0;
          const cacheReadTokens = (usage?.cache_read_input_tokens as number) ?? 0;

          // Tiered cache write tokens from cache_creation sub-object
          const cacheCreation = usage?.cache_creation as Record<string, unknown> | undefined;
          const cacheWrite5m = (cacheCreation?.ephemeral_5m_input_tokens as number) ?? 0;
          const cacheWrite1h = (cacheCreation?.ephemeral_1h_input_tokens as number) ?? 0;

          const model = (message?.model as string) ?? (entry.model as string) ?? null;
          if (model) modelSet.add(model);

          const uuid = (entry.uuid as string) ?? "";
          const parentUuid = (entry.parentUuid as string) ?? null;
          const stopReason = (message?.stop_reason as string) ?? null;
          const cwd = (entry.cwd as string) ?? null;
          const gitBranch = (entry.gitBranch as string) ?? null;

          const isFragment = isStreamingFragment(entryType, parentUuid, lastAssistantUuid);

          if (entryType === "assistant") {
            lastAssistantUuid = uuid;
          } else {
            lastAssistantUuid = "";
          }

          if (!isFragment) {
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            totalCacheCreationTokens += cacheCreationTokens;
            totalCacheReadTokens += cacheReadTokens;
            totalCacheWrite5mTokens += cacheWrite5m;
            totalCacheWrite1hTokens += cacheWrite1h;

            // Compute per-request cost
            const pricing = getPricing(model);
            const requestCost =
              (inputTokens / 1_000_000) * pricing.input +
              (outputTokens / 1_000_000) * pricing.output +
              (cacheWrite5m / 1_000_000) * pricing.cacheWrite5m +
              (cacheWrite1h / 1_000_000) * pricing.cacheWrite1h +
              (cacheReadTokens / 1_000_000) * pricing.cacheRead;
            estimatedCostAccum += requestCost;

            if (entryType === "assistant") {
              // Count tool_use and thinking blocks for this request
              let reqToolUseCount = 0;
              let reqThinkingCharCount = 0;
              for (const block of contentBlocks) {
                if ((block.type as string) === "tool_use") reqToolUseCount++;
                if ((block.type as string) === "thinking") {
                  reqThinkingCharCount += ((block.thinking as string) ?? "").length;
                }
              }

              apiRequests.push({
                sessionId,
                messageUuid: uuid,
                requestIndex: apiRequestCount,
                model: model ?? "",
                timestamp: ts,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                cacheWrite5mTokens: cacheWrite5m,
                cacheWrite1hTokens: cacheWrite1h,
                estimatedCostUsd: Math.round(requestCost * 10000) / 10000,
                stopReason,
                toolUseCount: reqToolUseCount,
                thinkingCharCount: reqThinkingCharCount,
              });
              apiRequestCount++;
            }
          }

          // Extract message content text
          const messageContent = entryType === "user"
            ? extractUserContent(entry)
            : extractContentText(contentBlocks);

          messages.push({
            sessionId,
            uuid,
            parentUuid,
            entryType,
            timestamp: ts,
            model,
            stopReason,
            inputTokens: isFragment ? 0 : inputTokens,
            outputTokens: isFragment ? 0 : outputTokens,
            cacheCreationTokens: isFragment ? 0 : cacheCreationTokens,
            cacheReadTokens: isFragment ? 0 : cacheReadTokens,
            contentBlockCount: contentBlocks.length,
            cwd,
            gitBranch,
            content: messageContent,
          });

          // Extract tool invocations from assistant content
          // (always extract from ALL entries — each fragment has unique blocks)
          if (entryType === "assistant") {
            for (const block of contentBlocks) {
              const blockType = block.type as string;

              if (blockType === "tool_use") {
                const toolUseId = (block.id as string) ?? "";
                const toolName = (block.name as string) ?? "";
                const inputRaw = block.input;
                const inputStr = typeof inputRaw === "string"
                  ? inputRaw
                  : JSON.stringify(inputRaw ?? "");
                const inputSummary = inputStr.slice(0, 2000);

                toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

                const inv: ToolInvocation = {
                  sessionId,
                  messageUuid: uuid,
                  toolUseId,
                  toolName,
                  inputSummary,
                  isError: false,
                  timestamp: ts,
                  durationMs: null,
                  resultSummary: null,
                  inputSizeBytes: Buffer.byteLength(inputStr, "utf-8"),
                  resultSizeBytes: 0,
                };
                toolInvocations.push(inv);
                toolMap.set(toolUseId, inv);
              }

              if (blockType === "thinking") {
                const thinkingContent = (block.thinking as string) ?? "";
                if (thinkingContent) {
                  thinkingCharCount += thinkingContent.length;
                  thinkingBlocks.push({
                    sessionId,
                    messageUuid: uuid,
                    content: thinkingContent,
                    contentLength: thinkingContent.length,
                    timestamp: ts,
                  });
                }
              }
            }
          }

          // Extract tool results from user content (tool_result blocks)
          // Captures error status, duration, result summary, and result size.
          // Duration is from tool_use (assistant msg) to tool_result (user msg).
          // When multiple tools are called in one round, all share the same
          // user message timestamp, so duration reflects round-trip time, not
          // per-tool latency.
          if (entryType === "user") {
            for (const block of contentBlocks) {
              if (block.type === "tool_result") {
                const toolUseId = (block.tool_use_id as string) ?? "";
                const inv = toolMap.get(toolUseId);
                if (inv) {
                  if (block.is_error === true) {
                    inv.isError = true;
                    errorCount++;
                  }

                  // Duration: user message timestamp - tool_use timestamp
                  if (ts && inv.timestamp) {
                    const elapsed = new Date(ts).getTime() - new Date(inv.timestamp).getTime();
                    if (elapsed >= 0) inv.durationMs = elapsed;
                  }

                  // Result content extraction
                  const resultContent = block.content;
                  let resultStr = "";
                  if (typeof resultContent === "string") {
                    resultStr = resultContent;
                  } else if (Array.isArray(resultContent)) {
                    resultStr = (resultContent as Record<string, unknown>[])
                      .filter((b) => b.type === "text")
                      .map((b) => (b.text as string) ?? "")
                      .join("\n");
                  }
                  if (resultStr) {
                    inv.resultSizeBytes = Buffer.byteLength(resultStr, "utf-8");
                    inv.resultSummary = resultStr.slice(0, 2000);
                  }
                }
              }
            }
          }
        }
      } catch {
        parseErrors++;
      }
    }

    // Cost was accumulated per-message using per-model pricing
    const estimatedCostUsd = estimatedCostAccum;

    // Duration in seconds
    let durationSeconds = 0;
    if (firstTimestamp && lastTimestamp) {
      durationSeconds = Math.max(
        0,
        (new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()) / 1000
      );
    }

    // Build tool breakdown object
    const toolBreakdown: Record<string, number> = {};
    for (const [name, count] of toolCounts) {
      toolBreakdown[name] = count;
    }

    const analytics: SessionAnalytics = {
      sessionId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
      totalCacheWrite5mTokens,
      totalCacheWrite1hTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      toolBreakdown,
      errorCount,
      totalToolUses: toolInvocations.length,
      thinkingBlockCount: thinkingBlocks.length,
      thinkingCharCount,
      subagentCount: 0, // filled in later by CLI after discovering subagents
      apiRequestCount,
      models: [...modelSet].join(","),
      durationSeconds,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: statSync(jsonlPath).size,
    };

    return { messages, toolInvocations, thinkingBlocks, apiRequests, analytics, parseErrors };
  }

  /**
   * Extract metadata from a subagent JSONL file.
   * Lighter extraction: first user prompt, counts, token sums, timestamps.
   */
  async extractSubagentMeta(
    jsonlPath: string,
    parentSessionId: string,
    agentId: string
  ): Promise<SubagentRun> {
    let prompt = "";
    let messageCount = 0;
    let toolUseCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let firstTimestamp = "";
    let lastTimestamp = "";
    let lastAssistantUuid = "";

    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const entryType = entry.type as string | undefined;
        if (!entryType || entryType === "progress" || entryType === "queue-operation") {
          continue;
        }

        const ts = (entry.timestamp as string) ?? "";
        if (!firstTimestamp && ts) firstTimestamp = ts;
        if (ts) lastTimestamp = ts;

        if (entryType === "user" || entryType === "assistant" || entryType === "system") {
          messageCount++;

          const uuid = (entry.uuid as string) ?? "";
          const parentUuid = (entry.parentUuid as string) ?? "";
          const isFragment = isStreamingFragment(entryType, parentUuid, lastAssistantUuid);

          if (entryType === "assistant") {
            lastAssistantUuid = uuid;
          } else {
            lastAssistantUuid = "";
          }

          // Only accumulate tokens from root entries (not streaming fragments)
          if (!isFragment) {
            const message = entry.message as Record<string, unknown> | undefined;
            const usage = (message?.usage as Record<string, unknown>) ??
              (entry.usage as Record<string, unknown> | undefined);
            totalInputTokens += (usage?.input_tokens as number) ?? 0;
            totalOutputTokens += (usage?.output_tokens as number) ?? 0;
          }

          const message = entry.message as Record<string, unknown> | undefined;
          const content = message?.content;

          // Capture first user message as prompt
          if (entryType === "user" && !prompt) {
            if (typeof content === "string") {
              prompt = content.slice(0, 500);
            } else if (Array.isArray(content)) {
              const textBlock = (content as Record<string, unknown>[]).find(
                (b) => b.type === "text"
              );
              if (textBlock) {
                prompt = ((textBlock.text as string) ?? "").slice(0, 500);
              }
            }
          }

          // Count tool_use blocks from ALL entries (each fragment has unique blocks)
          if (entryType === "assistant" && Array.isArray(content)) {
            toolUseCount += (content as Record<string, unknown>[]).filter(
              (b) => b.type === "tool_use"
            ).length;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(jsonlPath);

    return {
      parentSessionId,
      agentId,
      jsonlPath,
      prompt,
      messageCount,
      toolUseCount,
      totalInputTokens,
      totalOutputTokens,
      startedAt: firstTimestamp,
      endedAt: lastTimestamp,
      fileSizeBytes: fileStat.size,
    };
  }

  // ---- Private helpers ----

  /** Split markdown into sections by ## headers. */
  private _splitMarkdownSections(content: string): string[] {
    const sections = content.split(/\n(?=## )/);
    return sections.filter((s) => s.trim().length > 20);
  }

  /** Guess the category of a learning from its content. */
  private _categorize(content: string): LearningCategory {
    const lower = content.toLowerCase();
    if (lower.includes("bug") || lower.includes("fixed") || lower.includes("broke"))
      return "bug";
    if (lower.includes("gotcha") || lower.includes("trap") || lower.includes("pitfall"))
      return "gotcha";
    if (lower.includes("architecture") || lower.includes("structure") || lower.includes("layout"))
      return "architecture";
    if (lower.includes("decision") || lower.includes("chose") || lower.includes("rationale"))
      return "decision";
    if (lower.includes("convention") || lower.includes("must") || lower.includes("rule"))
      return "convention";
    return "pattern";
  }
}
