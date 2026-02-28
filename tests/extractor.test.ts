import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningExtractor } from "../src/analyzer/extractor.js";

describe("LearningExtractor", () => {
  let extractor: LearningExtractor;
  let tempDir: string;

  beforeEach(() => {
    extractor = new LearningExtractor();
    tempDir = join(tmpdir(), `monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Write JSONL lines to a temp file and return the path. */
  function writeJsonl(lines: Record<string, unknown>[]): string {
    const filePath = join(tempDir, `session-${Date.now()}.jsonl`);
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  // ---- extractSessionMeta ----

  describe("extractSessionMeta", () => {
    it("extracts basic session metadata", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "2026-02-25T10:00:00Z", sessionId: "sess-1", message: { content: [{ type: "text", text: "Hello" }] } },
        { type: "assistant", timestamp: "2026-02-25T10:00:05Z", sessionId: "sess-1", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } },
        { type: "user", timestamp: "2026-02-25T10:00:10Z", sessionId: "sess-1", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      ]);

      const session = await extractor.extractSessionMeta(filePath, "test-project");
      expect(session.sessionId).toBe("sess-1");
      expect(session.userMessageCount).toBe(2);
      expect(session.assistantMessageCount).toBe(1);
      expect(session.toolUseCount).toBe(1);
      expect(session.startedAt).toBe("2026-02-25T10:00:00Z");
      expect(session.endedAt).toBe("2026-02-25T10:00:10Z");
    });

    it("deduplicates assistant count for streaming fragments", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "T1", uuid: "u1", sessionId: "s1", message: { content: [] } },
        // Single API response split into 2 fragments (thinking + tool_use)
        { type: "assistant", timestamp: "T2", uuid: "a1", parentUuid: "u1", sessionId: "s1", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
        { type: "assistant", timestamp: "T2", uuid: "a2", parentUuid: "a1", sessionId: "s1", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
        { type: "user", timestamp: "T3", uuid: "u2", sessionId: "s1", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
        // Second API response (single entry)
        { type: "assistant", timestamp: "T4", uuid: "a3", parentUuid: "u2", sessionId: "s1", message: { content: [{ type: "text", text: "done" }] } },
      ]);

      const session = await extractor.extractSessionMeta(filePath, "test-project");
      expect(session.assistantMessageCount).toBe(2); // 2 API responses, not 3 entries
      expect(session.toolUseCount).toBe(1); // tool_use still counted from fragments
      expect(session.userMessageCount).toBe(2);
    });

    it("handles malformed lines gracefully", async () => {
      const filePath = join(tempDir, "malformed.jsonl");
      writeFileSync(filePath, '{"type":"user","timestamp":"T1","sessionId":"s1"}\nNOT JSON\n{"type":"assistant","timestamp":"T2","message":{"content":[]}}\n', "utf-8");

      const session = await extractor.extractSessionMeta(filePath, "test");
      expect(session.userMessageCount).toBe(1);
      expect(session.assistantMessageCount).toBe(1);
    });
  });

  // ---- extractSessionDeep ----

  describe("extractSessionDeep", () => {
    it("extracts messages from user/assistant/system entries", async () => {
      const filePath = writeJsonl([
        {
          type: "system", timestamp: "2026-02-25T10:00:00Z", uuid: "sys-1", parentUuid: null,
          message: { content: [{ type: "text", text: "System prompt" }] },
        },
        {
          type: "user", timestamp: "2026-02-25T10:00:01Z", uuid: "u-1", parentUuid: "sys-1",
          message: { content: [{ type: "text", text: "Hello" }] },
          cwd: "/project", gitBranch: "main",
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:05Z", uuid: "a-1", parentUuid: "u-1",
          message: {
            model: "claude-opus-4-6", content: [{ type: "text", text: "Hi!" }], stop_reason: "end_turn",
            usage: { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 200, cache_read_input_tokens: 100 },
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.messages).toHaveLength(3);

      const userMsg = result.messages.find((m) => m.entryType === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.cwd).toBe("/project");
      expect(userMsg!.gitBranch).toBe("main");

      const assistantMsg = result.messages.find((m) => m.entryType === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.model).toBe("claude-opus-4-6");
      expect(assistantMsg!.stopReason).toBe("end_turn");
      expect(assistantMsg!.inputTokens).toBe(1500);
      expect(assistantMsg!.outputTokens).toBe(800);
      expect(assistantMsg!.cacheCreationTokens).toBe(200);
      expect(assistantMsg!.cacheReadTokens).toBe(100);
    });

    it("skips progress and queue-operation entries", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "T1", uuid: "u1", message: { content: [] } },
        { type: "progress", timestamp: "T2" },
        { type: "progress", timestamp: "T3" },
        { type: "queue-operation", timestamp: "T4" },
        { type: "assistant", timestamp: "T5", uuid: "a1", message: { content: [] }, usage: {} },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.messages).toHaveLength(2); // Only user + assistant
    });

    it("extracts tool invocations from assistant content", async () => {
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "2026-02-25T10:00:00Z", uuid: "a-1",
          message: {
            content: [
              { type: "text", text: "Let me read that file" },
              { type: "tool_use", id: "toolu_001", name: "Read", input: { file_path: "/src/index.ts" } },
              { type: "tool_use", id: "toolu_002", name: "Bash", input: { command: "npm test" } },
            ],
          },
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.toolInvocations).toHaveLength(2);
      expect(result.toolInvocations[0].toolName).toBe("Read");
      expect(result.toolInvocations[0].toolUseId).toBe("toolu_001");
      expect(result.toolInvocations[0].inputSummary).toContain("file_path");
      expect(result.toolInvocations[1].toolName).toBe("Bash");
    });

    it("marks tool errors from user tool_result blocks", async () => {
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "T1", uuid: "a-1",
          message: {
            content: [
              { type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "bad cmd" } },
              { type: "tool_use", id: "toolu_ok", name: "Read", input: { file_path: "/ok" } },
            ],
          },
          usage: {},
        },
        {
          type: "user", timestamp: "T2", uuid: "u-1",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_err", is_error: true, content: "command failed" },
              { type: "tool_result", tool_use_id: "toolu_ok", content: "file contents" },
            ],
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.toolInvocations).toHaveLength(2);

      const errTool = result.toolInvocations.find((t) => t.toolUseId === "toolu_err");
      expect(errTool!.isError).toBe(true);

      const okTool = result.toolInvocations.find((t) => t.toolUseId === "toolu_ok");
      expect(okTool!.isError).toBe(false);

      expect(result.analytics.errorCount).toBe(1);
    });

    it("extracts thinking blocks with full content", async () => {
      const thinkingContent = "I need to carefully analyze this code to understand the issue. The problem seems to be in the database layer where transactions are not properly wrapped.";
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "2026-02-25T10:00:00Z", uuid: "a-1",
          message: {
            content: [
              { type: "thinking", thinking: thinkingContent },
              { type: "text", text: "Here is my analysis..." },
            ],
          },
          usage: { input_tokens: 500, output_tokens: 300 },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.thinkingBlocks).toHaveLength(1);
      expect(result.thinkingBlocks[0].content).toBe(thinkingContent);
      expect(result.thinkingBlocks[0].contentLength).toBe(thinkingContent.length);
      expect(result.analytics.thinkingBlockCount).toBe(1);
      expect(result.analytics.thinkingCharCount).toBe(thinkingContent.length);
    });

    it("computes analytics with correct token totals and Opus 4.6 cost", async () => {
      // Real JSONL structure: usage at message.usage with tiered cache_creation sub-object
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "2026-02-25T10:00:00Z", uuid: "a-1",
          message: {
            model: "claude-opus-4-6", content: [], stop_reason: "tool_use",
            usage: {
              input_tokens: 10000, output_tokens: 5000,
              cache_creation_input_tokens: 2000, cache_read_input_tokens: 1000,
              cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1500 },
            },
          },
        },
        {
          type: "user", timestamp: "2026-02-25T10:00:05Z", uuid: "u-1",
          message: { content: [] },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:10Z", uuid: "a-2",
          message: {
            model: "claude-opus-4-6", content: [], stop_reason: "end_turn",
            usage: {
              input_tokens: 15000, output_tokens: 3000,
              cache_creation_input_tokens: 0, cache_read_input_tokens: 5000,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            },
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      const a = result.analytics;

      expect(a.totalInputTokens).toBe(25000);
      expect(a.totalOutputTokens).toBe(8000);
      expect(a.totalCacheCreationTokens).toBe(2000);
      expect(a.totalCacheReadTokens).toBe(6000);
      expect(a.totalCacheWrite5mTokens).toBe(500);
      expect(a.totalCacheWrite1hTokens).toBe(1500);
      expect(a.apiRequestCount).toBe(2);

      // Cost with Opus 4.6 pricing:
      // (25000/1M * 5) + (8000/1M * 25) + (500/1M * 6.25) + (1500/1M * 10) + (6000/1M * 0.5)
      // = 0.125 + 0.2 + 0.003125 + 0.015 + 0.003
      // = 0.346125
      expect(a.estimatedCostUsd).toBeCloseTo(0.346125, 4);
      expect(a.models).toBe("claude-opus-4-6");
    });

    it("deduplicates tokens from streaming fragments", async () => {
      // Simulates a single API response split into 3 streaming fragments:
      // thinking → text → tool_use, all chained via parentUuid with identical usage
      const sharedUsage = {
        input_tokens: 5000, output_tokens: 2000,
        cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      };
      const filePath = writeJsonl([
        {
          type: "user", timestamp: "2026-02-25T10:00:00Z", uuid: "u-1", parentUuid: null,
          message: { content: [{ type: "text", text: "Do something" }] },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:05Z", uuid: "a-1", parentUuid: "u-1",
          message: {
            model: "claude-opus-4-6",
            content: [{ type: "thinking", thinking: "Let me think about this carefully." }],
            usage: sharedUsage,
          },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:05Z", uuid: "a-2", parentUuid: "a-1",
          message: {
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "Here is my response." }],
            usage: sharedUsage,
          },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:05Z", uuid: "a-3", parentUuid: "a-2",
          message: {
            model: "claude-opus-4-6",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/test" } }],
            usage: sharedUsage,
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");

      // All 4 entries become messages (user + 3 assistant fragments)
      expect(result.messages).toHaveLength(4);

      // Content is extracted from ALL fragments
      expect(result.thinkingBlocks).toHaveLength(1);
      expect(result.thinkingBlocks[0].content).toBe("Let me think about this carefully.");
      expect(result.toolInvocations).toHaveLength(1);
      expect(result.toolInvocations[0].toolName).toBe("Read");

      // Tokens are counted only ONCE (from the root entry, not fragments)
      expect(result.analytics.totalInputTokens).toBe(5000);
      expect(result.analytics.totalOutputTokens).toBe(2000);
      expect(result.analytics.totalCacheReadTokens).toBe(3000);
      expect(result.analytics.totalCacheCreationTokens).toBe(1000);
      expect(result.analytics.totalCacheWrite1hTokens).toBe(1000);

      // Only 1 API request despite 3 assistant entries
      expect(result.analytics.apiRequestCount).toBe(1);

      // Streaming fragment messages store 0 tokens to avoid double-counting in DB
      const fragmentMsgs = result.messages.filter((m) => m.entryType === "assistant" && m.inputTokens === 0);
      expect(fragmentMsgs).toHaveLength(2); // a-2 and a-3 are fragments
    });

    it("computes duration in seconds", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "2026-02-25T10:00:00Z", uuid: "u1", message: { content: [] } },
        { type: "assistant", timestamp: "2026-02-25T10:30:00Z", uuid: "a1", message: { content: [] }, usage: {} },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.analytics.durationSeconds).toBe(1800); // 30 minutes
    });

    it("builds tool breakdown map", async () => {
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "T1", uuid: "a1",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: {} },
              { type: "tool_use", id: "t2", name: "Read", input: {} },
              { type: "tool_use", id: "t3", name: "Write", input: {} },
              { type: "tool_use", id: "t4", name: "Bash", input: {} },
            ],
          },
          usage: {},
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.analytics.toolBreakdown).toEqual({ Read: 2, Write: 1, Bash: 1 });
      expect(result.analytics.totalToolUses).toBe(4);
    });

    it("truncates tool input to 2000 chars", async () => {
      const longInput = "x".repeat(5000);
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "T1", uuid: "a1",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Write", input: { content: longInput } },
            ],
          },
          usage: {},
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.toolInvocations[0].inputSummary.length).toBeLessThanOrEqual(2000);
    });

    it("tracks multiple models", async () => {
      const filePath = writeJsonl([
        { type: "assistant", timestamp: "T1", uuid: "a1", message: { model: "claude-opus-4-6", content: [] }, usage: {} },
        { type: "user", timestamp: "T2", uuid: "u1", message: { content: [] } },
        { type: "assistant", timestamp: "T3", uuid: "a2", message: { model: "claude-haiku-4-5-20251001", content: [] }, usage: {} },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      const models = result.analytics.models.split(",");
      expect(models).toContain("claude-opus-4-6");
      expect(models).toContain("claude-haiku-4-5-20251001");
    });

    it("computes mixed-model costs using per-model pricing", async () => {
      // Opus 4.6: 1M input = $5, Haiku 4.5: 1M input = $0.80
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "T1", uuid: "a1",
          message: {
            model: "claude-opus-4-6", content: [], stop_reason: "end_turn",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
          },
        },
        { type: "user", timestamp: "T2", uuid: "u1", message: { content: [] } },
        {
          type: "assistant", timestamp: "T3", uuid: "a2",
          message: {
            model: "claude-haiku-4-5-20251001", content: [], stop_reason: "end_turn",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      // Opus: 1M * $5/M = $5.00, Haiku: 1M * $0.80/M = $0.80
      expect(result.analytics.estimatedCostUsd).toBeCloseTo(5.80, 2);
    });

    it("falls back to Opus pricing for unknown model", async () => {
      const filePath = writeJsonl([
        {
          type: "assistant", timestamp: "T1", uuid: "a1",
          message: {
            model: "claude-unknown-model", content: [], stop_reason: "end_turn",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
          },
        },
      ]);

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      // Falls back to Opus 4.6 pricing: $5/M input
      expect(result.analytics.estimatedCostUsd).toBeCloseTo(5.0, 2);
    });

    it("handles empty JSONL file", async () => {
      const filePath = join(tempDir, "empty.jsonl");
      writeFileSync(filePath, "", "utf-8");

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.messages).toHaveLength(0);
      expect(result.toolInvocations).toHaveLength(0);
      expect(result.thinkingBlocks).toHaveLength(0);
      expect(result.analytics.totalInputTokens).toBe(0);
      expect(result.analytics.durationSeconds).toBe(0);
    });

    it("counts parse errors without aborting", async () => {
      const filePath = join(tempDir, "errors.jsonl");
      const lines = [
        JSON.stringify({ type: "user", timestamp: "T1", uuid: "u1", message: { content: [] } }),
        "BROKEN JSON LINE",
        "{incomplete",
        JSON.stringify({ type: "assistant", timestamp: "T2", uuid: "a1", message: { content: [] }, usage: {} }),
      ];
      writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      const result = await extractor.extractSessionDeep(filePath, "sess-1");
      expect(result.messages).toHaveLength(2);
      expect(result.parseErrors).toBe(2);
    });
  });

  // ---- extractSubagentMeta ----

  describe("extractSubagentMeta", () => {
    it("extracts subagent metadata", async () => {
      const filePath = writeJsonl([
        {
          type: "user", timestamp: "2026-02-25T10:00:00Z", uuid: "u1",
          message: { content: [{ type: "text", text: "Search for all TypeScript files and analyze them" }] },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:05Z", uuid: "a1",
          message: {
            content: [{ type: "text", text: "Found files" }, { type: "tool_use", id: "t1", name: "Glob", input: {} }],
            usage: { input_tokens: 2000, output_tokens: 1000 },
          },
        },
        {
          type: "user", timestamp: "2026-02-25T10:00:10Z", uuid: "u2",
          message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
        },
        {
          type: "assistant", timestamp: "2026-02-25T10:00:15Z", uuid: "a2",
          message: {
            content: [{ type: "text", text: "Done" }],
            usage: { input_tokens: 3000, output_tokens: 500 },
          },
        },
      ]);

      const run = await extractor.extractSubagentMeta(filePath, "parent-sess", "agent-abc");
      expect(run.parentSessionId).toBe("parent-sess");
      expect(run.agentId).toBe("agent-abc");
      expect(run.prompt).toContain("Search for all TypeScript");
      expect(run.messageCount).toBe(4);
      expect(run.toolUseCount).toBe(1);
      expect(run.totalInputTokens).toBe(5000);
      expect(run.totalOutputTokens).toBe(1500);
      expect(run.startedAt).toBe("2026-02-25T10:00:00Z");
      expect(run.endedAt).toBe("2026-02-25T10:00:15Z");
      expect(run.fileSizeBytes).toBeGreaterThan(0);
    });

    it("truncates prompt to 500 chars", async () => {
      const longPrompt = "Search ".repeat(200); // >500 chars
      const filePath = writeJsonl([
        { type: "user", timestamp: "T1", uuid: "u1", message: { content: [{ type: "text", text: longPrompt }] } },
        { type: "assistant", timestamp: "T2", uuid: "a1", message: { content: [] }, usage: {} },
      ]);

      const run = await extractor.extractSubagentMeta(filePath, "parent", "agent-1");
      expect(run.prompt.length).toBeLessThanOrEqual(500);
    });

    it("handles string content in user message", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "T1", uuid: "u1", message: { content: "Simple string content" } },
        { type: "assistant", timestamp: "T2", uuid: "a1", message: { content: [] }, usage: {} },
      ]);

      const run = await extractor.extractSubagentMeta(filePath, "parent", "agent-1");
      expect(run.prompt).toBe("Simple string content");
    });

    it("skips progress entries", async () => {
      const filePath = writeJsonl([
        { type: "user", timestamp: "T1", uuid: "u1", message: { content: "test" } },
        { type: "progress", timestamp: "T2" },
        { type: "progress", timestamp: "T3" },
        { type: "assistant", timestamp: "T4", uuid: "a1", message: { content: [] }, usage: {} },
      ]);

      const run = await extractor.extractSubagentMeta(filePath, "parent", "agent-1");
      expect(run.messageCount).toBe(2); // Only user + assistant
    });
  });

  // ---- Learning extraction ----

  describe("extractFromMemory", () => {
    it("splits markdown into sections", () => {
      const content = "## Architecture\n\nUse SQLite for storage.\n\n## Patterns\n\nAlways wrap transactions properly.\n";
      const learnings = extractor.extractFromMemory(content, "testapp", "-Users-kevin-Projects-testapp");
      expect(learnings).toHaveLength(2);
      expect(learnings[0].sourceType).toBe("memory");
      expect(learnings[0].projectName).toBe("testapp");
      expect(learnings[0].projectDirName).toBe("-Users-kevin-Projects-testapp");
    });

    it("categorizes content heuristically", () => {
      const content = "## Bug Report\n\nFixed a bug in the database layer that caused data corruption.\n\n## Architecture\n\nThe system uses a layered architecture with clear separation of concerns.\n";
      const learnings = extractor.extractFromMemory(content, "test", "-Users-kevin-Projects-test");
      const bugLearning = learnings.find((l) => l.content.includes("bug"));
      expect(bugLearning?.category).toBe("bug");
      const archLearning = learnings.find((l) => l.content.includes("architecture"));
      expect(archLearning?.category).toBe("architecture");
    });
  });

  describe("extractFromRules", () => {
    it("strips YAML frontmatter", () => {
      const rules = [
        { path: "test-rule.md", content: "---\ndescription: A test rule\n---\n# Rule\n\nMUST do X." },
      ];
      const learnings = extractor.extractFromRules(rules, "test", "-Users-kevin-Projects-test");
      expect(learnings).toHaveLength(1);
      expect(learnings[0].content).not.toContain("---");
      expect(learnings[0].content).toContain("MUST do X");
      expect(learnings[0].category).toBe("convention");
      expect(learnings[0].projectDirName).toBe("-Users-kevin-Projects-test");
    });
  });
});
