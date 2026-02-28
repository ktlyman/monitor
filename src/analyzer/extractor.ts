import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  Learning,
  LearningCategory,
  Session,
  SessionMessage,
  ToolInvocation,
  ThinkingBlock,
  SessionAnalytics,
  SubagentRun,
} from "../types/index.js";

/** Result of deep-extracting a session JSONL file. */
export interface DeepExtractionResult {
  messages: SessionMessage[];
  toolInvocations: ToolInvocation[];
  thinkingBlocks: ThinkingBlock[];
  analytics: SessionAnalytics;
  parseErrors: number;
}

/** Opus 4.6 pricing per million tokens (USD). */
const COST_PER_M = {
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
} as const;

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
          // Streaming fragment detection: consecutive assistant entries
          // chained via parentUuid share identical usage (same API response)
          const isFragment = parentUuid === lastAssistantUuid && lastAssistantUuid !== "";
          if (!isFragment) assistantCount++;
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
  extractFromMemory(content: string, projectName: string): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
      sourceType: "memory" as const,
      sourcePath: "memory/MEMORY.md",
      content: section.trim(),
      category: this._categorize(section),
      extractedAt: new Date().toISOString(),
    }));
  }

  /** Extract learnings from a CLAUDE.md file. */
  extractFromClaudeMd(content: string, projectName: string): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
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
    projectName: string
  ): Learning[] {
    const learnings: Learning[] = [];
    for (const file of files) {
      // Strip YAML frontmatter
      const content = file.content.replace(/^---[\s\S]*?---\n?/, "").trim();
      if (content) {
        learnings.push({
          projectName,
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
    projectName: string
  ): Learning[] {
    return this._splitMarkdownSections(content).map((section) => ({
      projectName,
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

    // Map tool_use IDs to their invocations for error marking
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
    const toolCounts = new Map<string, number>();
    const modelSet = new Set<string>();
    let firstTimestamp = "";
    let lastTimestamp = "";
    let parseErrors = 0;

    // Streaming fragment detection: consecutive assistant entries chained
    // via parentUuid share identical usage (same API response). Only count
    // tokens from the first entry in each group.
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

          // Detect streaming fragments: consecutive assistant entries chained
          // via parentUuid are part of the same API response with identical usage.
          // Only accumulate tokens from the root entry (first in the chain).
          const isStreamingFragment = entryType === "assistant"
            && parentUuid === lastAssistantUuid
            && lastAssistantUuid !== "";

          if (entryType === "assistant") {
            lastAssistantUuid = uuid;
          } else {
            lastAssistantUuid = "";
          }

          if (!isStreamingFragment) {
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            totalCacheCreationTokens += cacheCreationTokens;
            totalCacheReadTokens += cacheReadTokens;
            totalCacheWrite5mTokens += cacheWrite5m;
            totalCacheWrite1hTokens += cacheWrite1h;
            if (entryType === "assistant") apiRequestCount++;
          }

          messages.push({
            sessionId,
            uuid,
            parentUuid,
            entryType,
            timestamp: ts,
            model,
            stopReason,
            inputTokens: isStreamingFragment ? 0 : inputTokens,
            outputTokens: isStreamingFragment ? 0 : outputTokens,
            cacheCreationTokens: isStreamingFragment ? 0 : cacheCreationTokens,
            cacheReadTokens: isStreamingFragment ? 0 : cacheReadTokens,
            contentBlockCount: contentBlocks.length,
            cwd,
            gitBranch,
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

          // Extract tool errors from user content (tool_result blocks)
          if (entryType === "user") {
            for (const block of contentBlocks) {
              if (block.type === "tool_result" && block.is_error === true) {
                const toolUseId = (block.tool_use_id as string) ?? "";
                const inv = toolMap.get(toolUseId);
                if (inv) {
                  inv.isError = true;
                  errorCount++;
                }
              }
            }
          }
        }
      } catch {
        parseErrors++;
      }
    }

    // Compute cost estimate (Opus 4.6 pricing with tiered cache writes)
    const estimatedCostUsd =
      (totalInputTokens / 1_000_000) * COST_PER_M.input +
      (totalOutputTokens / 1_000_000) * COST_PER_M.output +
      (totalCacheWrite5mTokens / 1_000_000) * COST_PER_M.cacheWrite5m +
      (totalCacheWrite1hTokens / 1_000_000) * COST_PER_M.cacheWrite1h +
      (totalCacheReadTokens / 1_000_000) * COST_PER_M.cacheRead;

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
    };

    return { messages, toolInvocations, thinkingBlocks, analytics, parseErrors };
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

          // Streaming fragment detection (same as extractSessionDeep)
          const isFragment = entryType === "assistant"
            && parentUuid === lastAssistantUuid
            && lastAssistantUuid !== "";

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
