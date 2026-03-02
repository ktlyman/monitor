import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitorDatabase } from "../src/storage/database.js";
import { generateRecommendations } from "../src/analyzer/recommendations.js";
import type { Project, Session, SessionAnalytics, ToolInvocation } from "../src/types/index.js";

describe("generateRecommendations", () => {
  let db: MonitorDatabase;

  const testProject: Project = {
    dirName: "-Users-kevin-Projects-testapp",
    name: "testapp",
    projectPath: "/Users/kevin/Projects/testapp",
    sessionCount: 1,
    hasMemory: false,
    hasClaudeMd: false,
    lastScannedAt: new Date().toISOString(),
  };

  const testSession: Session = {
    sessionId: "sess-1",
    projectDirName: "-Users-kevin-Projects-testapp",
    jsonlPath: "/path/to/sess.jsonl",
    startedAt: "2026-02-25T10:00:00Z",
    endedAt: "2026-02-25T11:00:00Z",
    userMessageCount: 10,
    assistantMessageCount: 10,
    toolUseCount: 20,
    fileSizeBytes: 50000,
  };

  beforeEach(() => {
    db = new MonitorDatabase(":memory:");
    db.upsertProject(testProject);
    db.upsertSession(testSession);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty array when no issues found", () => {
    const recs = generateRecommendations(db);
    expect(recs).toEqual([]);
  });

  it("detects high error rate tools", () => {
    // 12 invocations with 4 errors (33% error rate)
    const tools: ToolInvocation[] = [];
    for (let i = 0; i < 12; i++) {
      tools.push({
        sessionId: "sess-1",
        messageUuid: "m1",
        toolUseId: `t${i}`,
        toolName: "Bash",
        inputSummary: "{}",
        isError: i < 4, // First 4 are errors
        timestamp: "T1",
        durationMs: null,
        resultSummary: null,
        inputSizeBytes: 2,
        resultSizeBytes: 0,
      });
    }
    db.insertToolInvocations(tools);

    const recs = generateRecommendations(db);
    const bashRec = recs.find((r) => r.message.includes("Bash"));
    expect(bashRec).toBeDefined();
    expect(bashRec!.type).toBe("reliability");
    expect(bashRec!.severity).toBe("warning");
    expect(bashRec!.detail).toContain("4 of 12");
  });

  it("does not flag tools below threshold", () => {
    // 5 invocations (below min 10 threshold)
    const tools: ToolInvocation[] = [];
    for (let i = 0; i < 5; i++) {
      tools.push({
        sessionId: "sess-1",
        messageUuid: "m1",
        toolUseId: `t${i}`,
        toolName: "Bash",
        inputSummary: "{}",
        isError: true,
        timestamp: "T1",
        durationMs: null,
        resultSummary: null,
        inputSizeBytes: 2,
        resultSizeBytes: 0,
      });
    }
    db.insertToolInvocations(tools);

    const recs = generateRecommendations(db);
    expect(recs.filter((r) => r.type === "reliability")).toHaveLength(0);
  });

  it("detects expensive sessions", () => {
    db.upsertSessionAnalytics({
      sessionId: "sess-1",
      totalInputTokens: 2_000_000,
      totalOutputTokens: 1_000_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0,
      totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 15.50,
      toolBreakdown: {},
      errorCount: 0,
      totalToolUses: 50,
      thinkingBlockCount: 10,
      thinkingCharCount: 5000,
      subagentCount: 0,
      apiRequestCount: 20,
      models: "claude-opus-4-6",
      durationSeconds: 3600,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const recs = generateRecommendations(db);
    const costRec = recs.find((r) => r.type === "cost");
    expect(costRec).toBeDefined();
    expect(costRec!.severity).toBe("warning");
    expect(costRec!.message).toContain("$15.50");
  });

  it("detects low cache utilization", () => {
    db.upsertSessionAnalytics({
      sessionId: "sess-1",
      totalInputTokens: 1_000_000,
      totalOutputTokens: 500_000,
      totalCacheCreationTokens: 50_000,
      totalCacheReadTokens: 5_000, // Only 0.5% cache hit
      totalCacheWrite5mTokens: 0,
      totalCacheWrite1hTokens: 50_000,
      estimatedCostUsd: 5.00,
      toolBreakdown: {},
      errorCount: 0,
      totalToolUses: 20,
      thinkingBlockCount: 5,
      thinkingCharCount: 2000,
      subagentCount: 0,
      apiRequestCount: 10,
      models: "claude-opus-4-6",
      durationSeconds: 1800,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const recs = generateRecommendations(db);
    const cacheRec = recs.find((r) => r.type === "efficiency");
    expect(cacheRec).toBeDefined();
    expect(cacheRec!.severity).toBe("info");
    expect(cacheRec!.message).toContain("cache");
  });

  it("does not flag cache when utilization is high", () => {
    db.upsertSessionAnalytics({
      sessionId: "sess-1",
      totalInputTokens: 1_000_000,
      totalOutputTokens: 500_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 500_000, // 50% cache hit — well above 10%
      totalCacheWrite5mTokens: 0,
      totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 3.00,
      toolBreakdown: {},
      errorCount: 0,
      totalToolUses: 10,
      thinkingBlockCount: 5,
      thinkingCharCount: 2000,
      subagentCount: 0,
      apiRequestCount: 8,
      models: "claude-opus-4-6",
      durationSeconds: 1200,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const recs = generateRecommendations(db);
    expect(recs.filter((r) => r.type === "efficiency")).toHaveLength(0);
  });
});
