import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitorDatabase } from "../src/storage/database.js";
import type {
  Project,
  Session,
  Learning,
  SessionMessage,
  ToolInvocation,
  ThinkingBlock,
  SubagentRun,
  ToolResultFile,
  SessionAnalytics,
} from "../src/types/index.js";

describe("MonitorDatabase", () => {
  let db: MonitorDatabase;

  beforeEach(() => {
    db = new MonitorDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ---- Schema ----

  it("initializes with schema v7", () => {
    // Verify all core tables exist by performing simple queries
    expect(() => db.getProjects()).not.toThrow();
    expect(() => db.getStats()).not.toThrow();
  });

  it("creates a fresh in-memory database without errors", () => {
    const db2 = new MonitorDatabase(":memory:");
    const stats = db2.getStats();
    expect(stats.totalProjects).toBe(0);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalLearnings).toBe(0);
    db2.close();
  });

  // ---- Projects ----

  const testProject: Project = {
    dirName: "-Users-kevin-Projects-testapp",
    name: "testapp",
    projectPath: "/Users/kevin/Projects/testapp",
    sessionCount: 5,
    hasMemory: true,
    hasClaudeMd: true,
    lastScannedAt: "2026-02-25T12:00:00.000Z",
  };

  it("upserts and retrieves projects", () => {
    db.upsertProject(testProject);
    const projects = db.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("testapp");
    expect(projects[0].sessionCount).toBe(5);
    expect(projects[0].hasMemory).toBe(true);
  });

  it("updates existing project on re-upsert", () => {
    db.upsertProject(testProject);
    db.upsertProject({ ...testProject, sessionCount: 10 });
    const projects = db.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].sessionCount).toBe(10);
  });

  // ---- Sessions ----

  const testSession: Session = {
    sessionId: "abc-123",
    projectDirName: "-Users-kevin-Projects-testapp",
    jsonlPath: "/path/to/session.jsonl",
    startedAt: "2026-02-25T10:00:00.000Z",
    endedAt: "2026-02-25T11:00:00.000Z",
    userMessageCount: 10,
    assistantMessageCount: 10,
    toolUseCount: 5,
    fileSizeBytes: 50000,
  };

  it("upserts sessions", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);
    const stats = db.getStats();
    expect(stats.totalSessions).toBe(1);
  });

  // ---- Learnings and FTS ----

  it("inserts and searches learnings via FTS5", () => {
    const learning: Learning = {
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Always use streaming readline for large JSONL files",
      category: "convention",
      extractedAt: "2026-02-25T12:00:00.000Z",
    };
    db.insertLearning(learning);

    const results = db.search({ query: "streaming readline" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].learning.content).toContain("streaming readline");
    expect(results[0].learning.projectDirName).toBe("-Users-kevin-Projects-testapp");
  });

  it("clears learnings for a project by dirName", () => {
    db.insertLearning({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Test learning content about patterns",
      category: "pattern",
      extractedAt: new Date().toISOString(),
    });
    expect(db.search({ query: "patterns" }).length).toBeGreaterThan(0);

    db.clearLearningsForProject("-Users-kevin-Projects-testapp");
    expect(db.search({ query: "patterns" }).length).toBe(0);
  });

  // ---- Project files ----

  it("upserts project files with content hashing", () => {
    const result1 = db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "claude_md",
      relativePath: "CLAUDE.md",
      content: "# Test CLAUDE.md\n\nSome content here.",
    });
    expect(result1.changed).toBe(true);

    // Same content => no change
    const result2 = db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "claude_md",
      relativePath: "CLAUDE.md",
      content: "# Test CLAUDE.md\n\nSome content here.",
    });
    expect(result2.changed).toBe(false);

    // Different content => changed
    const result3 = db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "claude_md",
      relativePath: "CLAUDE.md",
      content: "# Test CLAUDE.md\n\nUpdated content here.",
    });
    expect(result3.changed).toBe(true);
  });

  it("gets project files and file content by dirName", () => {
    db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "rules",
      relativePath: ".claude/rules/test.md",
      content: "# Test Rule",
    });

    const files = db.getProjectFiles("-Users-kevin-Projects-testapp");
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe(".claude/rules/test.md");
    expect(files[0].projectDirName).toBe("-Users-kevin-Projects-testapp");

    const file = db.getProjectFile("-Users-kevin-Projects-testapp", ".claude/rules/test.md");
    expect(file).not.toBeNull();
    expect(file!.content).toBe("# Test Rule");
  });

  it("creates file versions on content change", () => {
    db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "memory",
      relativePath: "memory/MEMORY.md",
      content: "Version 1",
    });
    db.upsertProjectFile({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      fileType: "memory",
      relativePath: "memory/MEMORY.md",
      content: "Version 2",
    });

    const file = db.getProjectFile("-Users-kevin-Projects-testapp", "memory/MEMORY.md");
    const versions = db.getFileVersions(file!.id!);
    // First insert creates version 1, second creates version 2
    expect(versions).toHaveLength(2);
    expect(file!.content).toBe("Version 2");
  });

  // ---- Session messages (batch insert) ----

  it("batch inserts session messages", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    const messages: SessionMessage[] = [
      {
        sessionId: "abc-123",
        uuid: "msg-1",
        parentUuid: null,
        entryType: "user",
        timestamp: "2026-02-25T10:00:00.000Z",
        model: null,
        stopReason: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        contentBlockCount: 1,
        cwd: "/home/user/project",
        gitBranch: "main",
        content: null,
      },
      {
        sessionId: "abc-123",
        uuid: "msg-2",
        parentUuid: "msg-1",
        entryType: "assistant",
        timestamp: "2026-02-25T10:00:05.000Z",
        model: "claude-opus-4-6",
        stopReason: "end_turn",
        inputTokens: 1500,
        outputTokens: 800,
        cacheCreationTokens: 200,
        cacheReadTokens: 100,
        contentBlockCount: 3,
        cwd: "/home/user/project",
        gitBranch: "main",
        content: null,
      },
    ];

    db.insertSessionMessages(messages);
    const retrieved = db.getSessionMessages("abc-123");
    expect(retrieved).toHaveLength(2);
    expect(retrieved[0].entryType).toBe("user");
    expect(retrieved[1].model).toBe("claude-opus-4-6");
    expect(retrieved[1].inputTokens).toBe(1500);
  });

  it("filters messages by entryType", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      { sessionId: "abc-123", uuid: "u1", parentUuid: null, entryType: "user", timestamp: "2026-02-25T10:00:00Z", model: null, stopReason: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
      { sessionId: "abc-123", uuid: "a1", parentUuid: "u1", entryType: "assistant", timestamp: "2026-02-25T10:00:01Z", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 2, cwd: null, gitBranch: null, content: null },
      { sessionId: "abc-123", uuid: "u2", parentUuid: "a1", entryType: "user", timestamp: "2026-02-25T10:00:02Z", model: null, stopReason: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
    ]);

    const assistantOnly = db.getSessionMessages("abc-123", { entryType: "assistant" });
    expect(assistantOnly).toHaveLength(1);
    expect(assistantOnly[0].uuid).toBe("a1");
  });

  // ---- Tool invocations (batch insert) ----

  it("batch inserts tool invocations", () => {
    const invocations: ToolInvocation[] = [
      {
        sessionId: "abc-123",
        messageUuid: "msg-2",
        toolUseId: "toolu_001",
        toolName: "Read",
        inputSummary: '{"file_path":"/src/index.ts"}',
        isError: false,
        timestamp: "2026-02-25T10:00:05.000Z",
      },
      {
        sessionId: "abc-123",
        messageUuid: "msg-2",
        toolUseId: "toolu_002",
        toolName: "Bash",
        inputSummary: '{"command":"npm test"}',
        isError: true,
        timestamp: "2026-02-25T10:00:06.000Z",
      },
    ];

    db.insertToolInvocations(invocations);
    const retrieved = db.getToolInvocations("abc-123");
    expect(retrieved).toHaveLength(2);
    expect(retrieved[0].toolName).toBe("Read");
    expect(retrieved[0].isError).toBe(false);
    expect(retrieved[1].toolName).toBe("Bash");
    expect(retrieved[1].isError).toBe(true);
  });

  it("filters tool invocations by name", () => {
    db.insertToolInvocations([
      { sessionId: "abc-123", messageUuid: "m1", toolUseId: "t1", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "2026-02-25T10:00:00Z" },
      { sessionId: "abc-123", messageUuid: "m1", toolUseId: "t2", toolName: "Write", inputSummary: "{}", isError: false, timestamp: "2026-02-25T10:00:01Z" },
      { sessionId: "abc-123", messageUuid: "m2", toolUseId: "t3", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "2026-02-25T10:00:02Z" },
    ]);

    const reads = db.getToolInvocations("abc-123", { toolName: "Read" });
    expect(reads).toHaveLength(2);
  });

  // ---- Thinking blocks and FTS ----

  it("inserts thinking blocks and searches via FTS5", () => {
    const blocks: ThinkingBlock[] = [
      {
        sessionId: "abc-123",
        messageUuid: "msg-2",
        content: "I need to carefully consider the database schema migration strategy for adding FTS5 support to thinking blocks",
        contentLength: 100,
        timestamp: "2026-02-25T10:00:05.000Z",
      },
      {
        sessionId: "abc-123",
        messageUuid: "msg-4",
        content: "The user wants to optimize the React component rendering pipeline",
        contentLength: 65,
        timestamp: "2026-02-25T10:00:10.000Z",
      },
    ];

    db.insertThinkingBlocks(blocks);

    const allBlocks = db.getThinkingBlocks("abc-123");
    expect(allBlocks).toHaveLength(2);

    // FTS search
    const results = db.searchThinking("database schema migration");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].block.content).toContain("database schema migration");

    const reactResults = db.searchThinking("React component");
    expect(reactResults.length).toBeGreaterThan(0);
  });

  it("FTS thinking search respects session filter", () => {
    db.insertThinkingBlocks([
      { sessionId: "sess-1", messageUuid: "m1", content: "Alpha bravo charlie thinking content", contentLength: 36, timestamp: "2026-02-25T10:00:00Z" },
      { sessionId: "sess-2", messageUuid: "m2", content: "Alpha bravo delta thinking content", contentLength: 35, timestamp: "2026-02-25T10:00:01Z" },
    ]);

    const all = db.searchThinking("alpha bravo");
    expect(all).toHaveLength(2);

    const sess1Only = db.searchThinking("alpha bravo", { sessionId: "sess-1" });
    expect(sess1Only).toHaveLength(1);
    expect(sess1Only[0].block.sessionId).toBe("sess-1");
  });

  it("FTS sync: deleting thinking blocks removes from FTS", () => {
    db.insertThinkingBlocks([
      { sessionId: "abc-123", messageUuid: "m1", content: "unique xylophone phrase for search", contentLength: 34, timestamp: "2026-02-25T10:00:00Z" },
    ]);

    expect(db.searchThinking("xylophone").length).toBe(1);

    db.clearDeepDataForSession("abc-123");
    expect(db.searchThinking("xylophone").length).toBe(0);
  });

  // ---- Subagent runs ----

  it("upserts subagent runs", () => {
    const run: SubagentRun = {
      parentSessionId: "abc-123",
      agentId: "agent-xyz",
      jsonlPath: "/path/to/subagent.jsonl",
      prompt: "Search for all TypeScript files in the project",
      messageCount: 8,
      toolUseCount: 3,
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      startedAt: "2026-02-25T10:05:00.000Z",
      endedAt: "2026-02-25T10:06:00.000Z",
      fileSizeBytes: 12000,
    };

    db.upsertSubagentRun(run);
    const runs = db.getSubagentRuns("abc-123");
    expect(runs).toHaveLength(1);
    expect(runs[0].agentId).toBe("agent-xyz");
    expect(runs[0].prompt).toContain("TypeScript");

    // Re-upsert with updated data
    db.upsertSubagentRun({ ...run, messageCount: 12 });
    const updated = db.getSubagentRuns("abc-123");
    expect(updated).toHaveLength(1);
    expect(updated[0].messageCount).toBe(12);
  });

  // ---- Tool result files ----

  it("upserts tool result files", () => {
    const file: ToolResultFile = {
      sessionId: "abc-123",
      toolUseId: "toolu_result_001",
      content: "file content from tool output here\nwith multiple lines",
      sizeBytes: 55,
    };

    db.upsertToolResultFile(file);
    const listing = db.getToolResultFiles("abc-123");
    expect(listing).toHaveLength(1);
    expect(listing[0].toolUseId).toBe("toolu_result_001");
    expect(listing[0].sizeBytes).toBe(55);

    const full = db.getToolResultFile("abc-123", "toolu_result_001");
    expect(full).not.toBeNull();
    expect(full!.content).toContain("file content");
  });

  // ---- Session analytics ----

  it("upserts and retrieves session analytics", () => {
    const analytics: SessionAnalytics = {
      sessionId: "abc-123",
      totalInputTokens: 50000,
      totalOutputTokens: 25000,
      totalCacheCreationTokens: 10000,
      totalCacheReadTokens: 5000,
      totalCacheWrite5mTokens: 3000,
      totalCacheWrite1hTokens: 7000,
      estimatedCostUsd: 3.25,
      toolBreakdown: { Read: 15, Write: 5, Bash: 8 },
      errorCount: 2,
      totalToolUses: 28,
      thinkingBlockCount: 10,
      thinkingCharCount: 5000,
      subagentCount: 1,
      apiRequestCount: 15,
      models: "claude-opus-4-6",
      durationSeconds: 3600,
      deepExtractedAt: "2026-02-25T12:00:00.000Z",
      deepExtractedFileSize: 0,
    };

    db.upsertSessionAnalytics(analytics);

    expect(db.isSessionDeepExtracted("abc-123")).toBe(true);
    expect(db.isSessionDeepExtracted("nonexistent")).toBe(false);

    const retrieved = db.getSessionAnalytics("abc-123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.totalInputTokens).toBe(50000);
    expect(retrieved!.estimatedCostUsd).toBe(3.25);
    expect(retrieved!.toolBreakdown.Read).toBe(15);
    expect(retrieved!.models).toBe("claude-opus-4-6");
  });

  // ---- getDeepExtractedFileSize ----

  it("returns null for non-extracted session file size", () => {
    expect(db.getDeepExtractedFileSize("nonexistent")).toBeNull();
  });

  it("returns stored file size after deep extraction", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);
    db.upsertSessionAnalytics({
      sessionId: "sess-001",
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0,
      totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 0.01,
      toolBreakdown: {},
      errorCount: 0,
      totalToolUses: 0,
      thinkingBlockCount: 0,
      thinkingCharCount: 0,
      subagentCount: 0,
      apiRequestCount: 1,
      models: "claude-opus-4-6",
      durationSeconds: 60,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 12345,
    });
    expect(db.getDeepExtractedFileSize("sess-001")).toBe(12345);
  });

  it("detects file size change for incremental re-extraction", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    // First extraction at 1000 bytes
    db.upsertSessionAnalytics({
      sessionId: "sess-001",
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0,
      totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 0.01,
      toolBreakdown: {},
      errorCount: 0,
      totalToolUses: 0,
      thinkingBlockCount: 0,
      thinkingCharCount: 0,
      subagentCount: 0,
      apiRequestCount: 1,
      models: "claude-opus-4-6",
      durationSeconds: 60,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 1000,
    });

    // Session file has grown
    const currentFileSize = 2000;
    const extractedSize = db.getDeepExtractedFileSize("sess-001");
    expect(extractedSize).toBe(1000);
    expect(extractedSize !== currentFileSize).toBe(true); // needs re-extraction
  });

  // ---- clearDeepDataForSession ----

  it("clears all deep data for a session", () => {
    // Insert various data
    db.insertSessionMessages([
      { sessionId: "abc-123", uuid: "m1", parentUuid: null, entryType: "user", timestamp: "2026-02-25T10:00:00Z", model: null, stopReason: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
    ]);
    db.insertToolInvocations([
      { sessionId: "abc-123", messageUuid: "m1", toolUseId: "t1", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "2026-02-25T10:00:00Z" },
    ]);
    db.insertThinkingBlocks([
      { sessionId: "abc-123", messageUuid: "m1", content: "test thinking", contentLength: 13, timestamp: "2026-02-25T10:00:00Z" },
    ]);
    db.upsertSubagentRun({
      parentSessionId: "abc-123", agentId: "a1", jsonlPath: "/path", prompt: "test",
      messageCount: 1, toolUseCount: 0, totalInputTokens: 100, totalOutputTokens: 50,
      startedAt: "2026-02-25T10:00:00Z", endedAt: "2026-02-25T10:01:00Z", fileSizeBytes: 100,
    });
    db.upsertToolResultFile({ sessionId: "abc-123", toolUseId: "tr1", content: "result", sizeBytes: 6 });
    db.upsertSessionAnalytics({
      sessionId: "abc-123", totalInputTokens: 100, totalOutputTokens: 50,
      totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0, totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 0.01,
      toolBreakdown: {}, errorCount: 0, totalToolUses: 1, thinkingBlockCount: 1,
      thinkingCharCount: 13, subagentCount: 1, apiRequestCount: 1,
      models: "test", durationSeconds: 60,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    // Verify everything exists
    expect(db.getSessionMessages("abc-123")).toHaveLength(1);
    expect(db.getToolInvocations("abc-123")).toHaveLength(1);
    expect(db.getThinkingBlocks("abc-123")).toHaveLength(1);
    expect(db.getSubagentRuns("abc-123")).toHaveLength(1);
    expect(db.getToolResultFiles("abc-123")).toHaveLength(1);
    expect(db.isSessionDeepExtracted("abc-123")).toBe(true);

    // Clear everything
    db.clearDeepDataForSession("abc-123");

    expect(db.getSessionMessages("abc-123")).toHaveLength(0);
    expect(db.getToolInvocations("abc-123")).toHaveLength(0);
    expect(db.getThinkingBlocks("abc-123")).toHaveLength(0);
    expect(db.getSubagentRuns("abc-123")).toHaveLength(0);
    expect(db.getToolResultFiles("abc-123")).toHaveLength(0);
    expect(db.isSessionDeepExtracted("abc-123")).toBe(false);
  });

  // ---- Analytics stats ----

  it("computes aggregate analytics stats", () => {
    // No analytics yet
    const noStats = db.getAnalyticsStats();
    expect(noStats).toBeUndefined();

    // Insert some tool invocations and messages for aggregation
    db.insertSessionMessages([
      { sessionId: "s1", uuid: "m1", parentUuid: null, entryType: "assistant", timestamp: "2026-02-25T10:00:00Z", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
      { sessionId: "s1", uuid: "m2", parentUuid: "m1", entryType: "user", timestamp: "2026-02-25T10:00:01Z", model: null, stopReason: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
    ]);
    db.insertToolInvocations([
      { sessionId: "s1", messageUuid: "m1", toolUseId: "t1", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "2026-02-25T10:00:00Z" },
    ]);
    db.insertThinkingBlocks([
      { sessionId: "s1", messageUuid: "m1", content: "test", contentLength: 4, timestamp: "2026-02-25T10:00:00Z" },
    ]);
    db.upsertSessionAnalytics({
      sessionId: "s1", totalInputTokens: 1000, totalOutputTokens: 500,
      totalCacheCreationTokens: 3000, totalCacheReadTokens: 8000,
      totalCacheWrite5mTokens: 500, totalCacheWrite1hTokens: 2500,
      estimatedCostUsd: 0.05,
      toolBreakdown: { Read: 1 }, errorCount: 0, totalToolUses: 1, thinkingBlockCount: 1,
      thinkingCharCount: 4, subagentCount: 0, apiRequestCount: 5,
      models: "claude-opus-4-6", durationSeconds: 60,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const stats = db.getAnalyticsStats();
    expect(stats).toBeDefined();
    expect(stats!.totalMessages).toBe(2);
    expect(stats!.totalToolInvocations).toBe(1);
    expect(stats!.totalThinkingBlocks).toBe(1);
    expect(stats!.totalInputTokens).toBe(1000);
    expect(stats!.totalOutputTokens).toBe(500);
    expect(stats!.totalCacheCreationTokens).toBe(3000);
    expect(stats!.totalCacheReadTokens).toBe(8000);
    expect(stats!.totalCacheWrite5mTokens).toBe(500);
    expect(stats!.totalCacheWrite1hTokens).toBe(2500);
    expect(stats!.totalApiRequests).toBe(5);
    expect(stats!.sessionsDeepExtracted).toBe(1);
    expect(stats!.topTools[0].name).toBe("Read");
    expect(stats!.modelBreakdown["claude-opus-4-6"]).toBe(1);
  });

  // ---- Stats includes analytics ----

  it("getStats includes analytics field when data exists", () => {
    db.upsertSessionAnalytics({
      sessionId: "s1", totalInputTokens: 100, totalOutputTokens: 50,
      totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0, totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 0.01,
      toolBreakdown: {}, errorCount: 0, totalToolUses: 0, thinkingBlockCount: 0,
      thinkingCharCount: 0, subagentCount: 0, apiRequestCount: 1,
      models: "test", durationSeconds: 30,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const stats = db.getStats();
    expect(stats.analytics).toBeDefined();
    expect(stats.analytics!.sessionsDeepExtracted).toBe(1);
  });

  // ---- Tool success rates ----

  it("computes tool success rates", () => {
    db.insertToolInvocations([
      { sessionId: "s1", messageUuid: "m1", toolUseId: "t1", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "T1" },
      { sessionId: "s1", messageUuid: "m1", toolUseId: "t2", toolName: "Read", inputSummary: "{}", isError: true, timestamp: "T2" },
      { sessionId: "s1", messageUuid: "m1", toolUseId: "t3", toolName: "Read", inputSummary: "{}", isError: false, timestamp: "T3" },
      { sessionId: "s1", messageUuid: "m1", toolUseId: "t4", toolName: "Bash", inputSummary: "{}", isError: false, timestamp: "T4" },
    ]);

    const rates = db.getToolSuccessRates();
    const readRate = rates.find((r) => r.toolName === "Read");
    expect(readRate).toBeDefined();
    expect(readRate!.total).toBe(3);
    expect(readRate!.errors).toBe(1);
    expect(readRate!.successRate).toBeCloseTo(0.6667, 3);

    const bashRate = rates.find((r) => r.toolName === "Bash");
    expect(bashRate).toBeDefined();
    expect(bashRate!.successRate).toBe(1);
  });

  // ---- Model stats ----

  it("returns per-model message stats", () => {
    db.insertSessionMessages([
      { sessionId: "s1", uuid: "m-opus", parentUuid: null, entryType: "assistant", timestamp: "T1", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 5000, outputTokens: 2000, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
      { sessionId: "s1", uuid: "m-haiku1", parentUuid: null, entryType: "assistant", timestamp: "T2", model: "claude-haiku-4-5-20251001", stopReason: "end_turn", inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
      { sessionId: "s1", uuid: "m-haiku2", parentUuid: null, entryType: "assistant", timestamp: "T3", model: "claude-haiku-4-5-20251001", stopReason: "end_turn", inputTokens: 2000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0, contentBlockCount: 1, cwd: null, gitBranch: null, content: null },
    ]);

    const stats = db.getModelStats();
    const opus = stats.find((s) => s.model === "claude-opus-4-6");
    expect(opus).toBeDefined();
    expect(opus!.messageCount).toBe(1);
    expect(opus!.totalInputTokens).toBe(5000);

    const haiku = stats.find((s) => s.model === "claude-haiku-4-5-20251001");
    expect(haiku).toBeDefined();
    expect(haiku!.messageCount).toBe(2);
    expect(haiku!.totalInputTokens).toBe(3000);
  });

  // ---- Project coverage ----

  it("reports project analytics coverage", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);
    db.upsertSessionAnalytics({
      sessionId: "abc-123", totalInputTokens: 50000, totalOutputTokens: 25000,
      totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0, totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 1.50,
      toolBreakdown: {}, errorCount: 0, totalToolUses: 10, thinkingBlockCount: 5,
      thinkingCharCount: 2000, subagentCount: 0, apiRequestCount: 8,
      models: "claude-opus-4-6", durationSeconds: 600,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const coverage = db.getProjectAnalyticsCoverage();
    const project = coverage.find((c) => c.dirName === testProject.dirName);
    expect(project).toBeDefined();
    expect(project!.deepExtractedSessions).toBe(1);
    expect(project!.totalCostUsd).toBeCloseTo(1.50, 2);
  });

  // ---- Expensive sessions/projects ----

  it("returns most expensive sessions", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);
    db.upsertSession({ ...testSession, sessionId: "sess-2" });

    db.upsertSessionAnalytics({
      sessionId: "abc-123", totalInputTokens: 100000, totalOutputTokens: 50000,
      totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0, totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 5.00,
      toolBreakdown: {}, errorCount: 0, totalToolUses: 20, thinkingBlockCount: 10,
      thinkingCharCount: 5000, subagentCount: 0, apiRequestCount: 15,
      models: "claude-opus-4-6", durationSeconds: 1800,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });
    db.upsertSessionAnalytics({
      sessionId: "sess-2", totalInputTokens: 200000, totalOutputTokens: 100000,
      totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      totalCacheWrite5mTokens: 0, totalCacheWrite1hTokens: 0,
      estimatedCostUsd: 12.00,
      toolBreakdown: {}, errorCount: 0, totalToolUses: 50, thinkingBlockCount: 20,
      thinkingCharCount: 10000, subagentCount: 0, apiRequestCount: 30,
      models: "claude-opus-4-6", durationSeconds: 3600,
      deepExtractedAt: new Date().toISOString(),
      deepExtractedFileSize: 0,
    });

    const expensive = db.getMostExpensiveSessions(2);
    expect(expensive).toHaveLength(2);
    expect(expensive[0].estimatedCostUsd).toBe(12.00);
    expect(expensive[1].estimatedCostUsd).toBe(5.00);
  });

  // ---- getProjectByName ----

  it("looks up project by name", () => {
    db.upsertProject(testProject);
    const found = db.getProjectByName("testapp");
    expect(found).not.toBeNull();
    expect(found!.dirName).toBe("-Users-kevin-Projects-testapp");

    const notFound = db.getProjectByName("nonexistent");
    expect(notFound).toBeNull();
  });

  // ---- resolveProject ----

  it("resolves project by dir_name (primary key)", () => {
    db.upsertProject(testProject);
    const found = db.resolveProject("-Users-kevin-Projects-testapp");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("testapp");
  });

  it("resolves project by name as fallback", () => {
    db.upsertProject(testProject);
    const found = db.resolveProject("testapp");
    expect(found).not.toBeNull();
    expect(found!.dirName).toBe("-Users-kevin-Projects-testapp");
  });

  it("returns null when neither dir_name nor name matches", () => {
    db.upsertProject(testProject);
    const found = db.resolveProject("nonexistent");
    expect(found).toBeNull();
  });

  it("prefers dir_name over name on collision", () => {
    db.upsertProject(testProject);
    // Insert a second project whose dir_name happens to be "testapp"
    db.upsertProject({
      dirName: "testapp",
      name: "collision",
      projectPath: "/other/testapp",
      sessionCount: 1,
      hasMemory: false,
      hasClaudeMd: false,
      lastScannedAt: new Date().toISOString(),
    });
    const found = db.resolveProject("testapp");
    // Should match the one where "testapp" is the dir_name, not the name
    expect(found!.dirName).toBe("testapp");
    expect(found!.name).toBe("collision");
  });

  // ---- search with projectDirNames ----

  it("searches learnings filtered by projectDirNames", () => {
    db.insertLearning({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Use SQLite for data storage and persistence",
      category: "architecture",
      extractedAt: new Date().toISOString(),
    });
    db.insertLearning({
      projectName: "other",
      projectDirName: "-Users-kevin-Projects-other",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Use SQLite for other project persistence",
      category: "architecture",
      extractedAt: new Date().toISOString(),
    });

    const results = db.search({
      query: "SQLite persistence",
      projectDirNames: ["-Users-kevin-Projects-testapp"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].learning.projectDirName).toBe("-Users-kevin-Projects-testapp");
  });

  // ---- getLearningsForProject ----

  it("gets learnings for a project by dirName", () => {
    db.insertLearning({
      projectName: "testapp",
      projectDirName: "-Users-kevin-Projects-testapp",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Use SQLite for storage",
      category: "architecture",
      extractedAt: new Date().toISOString(),
    });
    db.insertLearning({
      projectName: "other",
      projectDirName: "-Users-kevin-Projects-other",
      sourceType: "memory",
      sourcePath: "memory/MEMORY.md",
      content: "Different project",
      category: "pattern",
      extractedAt: new Date().toISOString(),
    });

    const learnings = db.getLearningsForProject("-Users-kevin-Projects-testapp");
    expect(learnings).toHaveLength(1);
    expect(learnings[0].content).toContain("SQLite");
  });

  // ---- Message content and FTS ----

  it("stores and retrieves message content", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "mc-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "Please refactor the authentication module",
      },
      {
        sessionId: "abc-123", uuid: "mc-2", parentUuid: "mc-1",
        entryType: "assistant", timestamp: "2026-02-25T10:00:05Z",
        model: "claude-opus-4-6", stopReason: "end_turn",
        inputTokens: 1000, outputTokens: 500,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 2, cwd: null, gitBranch: null,
        content: "I'll refactor the authentication module by extracting the JWT validation logic",
      },
    ]);

    const messages = db.getSessionMessages("abc-123");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Please refactor the authentication module");
    expect(messages[1].content).toContain("JWT validation");
  });

  it("handles null content in messages (backward compat)", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "nc-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: null,
      },
    ]);

    const messages = db.getSessionMessages("abc-123");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBeNull();
  });

  it("searches message content via FTS5", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "fs-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "Help me implement websocket reconnection logic with exponential backoff",
      },
      {
        sessionId: "abc-123", uuid: "fs-2", parentUuid: "fs-1",
        entryType: "assistant", timestamp: "2026-02-25T10:00:05Z",
        model: "claude-opus-4-6", stopReason: "end_turn",
        inputTokens: 1000, outputTokens: 500,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "I'll implement the websocket reconnection with exponential backoff strategy",
      },
    ]);

    const results = db.searchMessages("websocket exponential backoff");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].projectName).toBe("testapp");
  });

  it("FTS message search respects session and entryType filters", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);
    db.upsertSession({ ...testSession, sessionId: "sess-other" });

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "sf-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "Unique zymurgy fermentation phrase for searching",
      },
      {
        sessionId: "sess-other", uuid: "sf-2", parentUuid: null,
        entryType: "assistant", timestamp: "2026-02-25T10:00:00Z",
        model: "claude-opus-4-6", stopReason: "end_turn",
        inputTokens: 100, outputTokens: 50,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "Unique zymurgy fermentation in another session",
      },
    ]);

    const all = db.searchMessages("zymurgy fermentation");
    expect(all).toHaveLength(2);

    const filtered = db.searchMessages("zymurgy fermentation", { sessionId: "abc-123" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].message.sessionId).toBe("abc-123");

    const byType = db.searchMessages("zymurgy fermentation", { entryType: "assistant" });
    expect(byType).toHaveLength(1);
    expect(byType[0].message.entryType).toBe("assistant");
  });

  it("FTS message sync: deleting messages removes from FTS", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "del-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: "Xylophone melody uniquely searchable phrase for deletion test",
      },
    ]);

    expect(db.searchMessages("xylophone melody").length).toBe(1);
    db.clearDeepDataForSession("abc-123");
    expect(db.searchMessages("xylophone melody").length).toBe(0);
  });

  it("null content messages are not indexed in FTS", () => {
    db.upsertProject(testProject);
    db.upsertSession(testSession);

    db.insertSessionMessages([
      {
        sessionId: "abc-123", uuid: "null-fts-1", parentUuid: null,
        entryType: "user", timestamp: "2026-02-25T10:00:00Z",
        model: null, stopReason: null,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        contentBlockCount: 1, cwd: null, gitBranch: null,
        content: null,
      },
    ]);

    // Should not throw even with no FTS entries
    const results = db.searchMessages("anything");
    expect(results).toHaveLength(0);
  });
});
