import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectScanner } from "../src/collector/scanner.js";

describe("ProjectScanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `monitor-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---- Static helpers ----

  describe("parseProjectName", () => {
    it("extracts last segment from encoded dir name", () => {
      expect(ProjectScanner.parseProjectName("-Users-kevin-Projects-monitor")).toBe("monitor");
      expect(ProjectScanner.parseProjectName("-Users-kevin-testing-myapp")).toBe("myapp");
    });
  });

  describe("deriveProjectPath", () => {
    it("converts encoded dir name to absolute path", () => {
      expect(ProjectScanner.deriveProjectPath("-Users-kevin-Projects-monitor")).toBe("/Users/kevin/Projects/monitor");
    });
  });

  // ---- discoverProjects ----

  describe("discoverProjects", () => {
    it("discovers project directories", async () => {
      // Create fake project dirs with session files
      const projectDir = join(tempDir, "-Users-test-Projects-alpha");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "session-1.jsonl"), '{"type":"user","timestamp":"T1","sessionId":"s1"}\n', "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.discoverProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
      expect(projects[0].name).toBe("alpha");
    });

    it("skips hidden directories", async () => {
      mkdirSync(join(tempDir, ".hidden"), { recursive: true });
      mkdirSync(join(tempDir, "-Users-test-Projects-visible"), { recursive: true });

      const scanner = new ProjectScanner(tempDir);
      const projects = await scanner.discoverProjects();
      expect(projects.every((p) => !p.dirName.startsWith("."))).toBe(true);
    });
  });

  // ---- discoverSessions ----

  describe("discoverSessions", () => {
    it("finds JSONL session files", async () => {
      const projectDir = join(tempDir, "test-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "sess-1.jsonl"), "{}\n", "utf-8");
      writeFileSync(join(projectDir, "sess-2.jsonl"), "{}\n", "utf-8");
      writeFileSync(join(projectDir, "readme.txt"), "not a session", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const sessions = await scanner.discoverSessions("test-project");
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.endsWith(".jsonl"))).toBe(true);
    });
  });

  // ---- discoverSessionDirectories ----

  describe("discoverSessionDirectories", () => {
    it("finds session UUID directories", async () => {
      const projectDir = join(tempDir, "test-project");
      mkdirSync(join(projectDir, "abc-123-def"), { recursive: true });
      mkdirSync(join(projectDir, "xyz-789-ghi"), { recursive: true });
      mkdirSync(join(projectDir, "memory"), { recursive: true }); // should be excluded
      mkdirSync(join(projectDir, ".hidden"), { recursive: true }); // should be excluded
      writeFileSync(join(projectDir, "session.jsonl"), "{}\n", "utf-8"); // file, not dir

      const scanner = new ProjectScanner(tempDir);
      const dirs = await scanner.discoverSessionDirectories("test-project");
      expect(dirs).toHaveLength(2);
      expect(dirs).toContain("abc-123-def");
      expect(dirs).toContain("xyz-789-ghi");
      expect(dirs).not.toContain("memory");
      expect(dirs).not.toContain(".hidden");
    });

    it("returns empty array for nonexistent project", async () => {
      const scanner = new ProjectScanner(tempDir);
      const dirs = await scanner.discoverSessionDirectories("nonexistent");
      expect(dirs).toEqual([]);
    });
  });

  // ---- discoverSubagentSessions ----

  describe("discoverSubagentSessions", () => {
    it("finds subagent JSONL files", async () => {
      const subagentsDir = join(tempDir, "test-project", "abc-123", "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(join(subagentsDir, "agent-xyz.jsonl"), "{}\n", "utf-8");
      writeFileSync(join(subagentsDir, "agent-abc-def.jsonl"), "{}\n", "utf-8");
      writeFileSync(join(subagentsDir, "other.txt"), "not a subagent", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const subagents = await scanner.discoverSubagentSessions("test-project", "abc-123");
      expect(subagents).toHaveLength(2);

      const ids = subagents.map((s) => s.agentId).sort();
      expect(ids).toContain("xyz");
      expect(ids).toContain("abc-def");
      expect(subagents.every((s) => s.jsonlPath.endsWith(".jsonl"))).toBe(true);
    });

    it("returns empty for directory without subagents", async () => {
      mkdirSync(join(tempDir, "test-project", "abc-123"), { recursive: true });
      const scanner = new ProjectScanner(tempDir);
      const subagents = await scanner.discoverSubagentSessions("test-project", "abc-123");
      expect(subagents).toEqual([]);
    });
  });

  // ---- discoverToolResultFiles ----

  describe("discoverToolResultFiles", () => {
    it("finds tool result .txt files", async () => {
      const resultsDir = join(tempDir, "test-project", "abc-123", "tool-results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, "toolu_001.txt"), "result 1", "utf-8");
      writeFileSync(join(resultsDir, "toolu_002.txt"), "result 2", "utf-8");
      writeFileSync(join(resultsDir, "other.json"), "{}", "utf-8"); // not .txt

      const scanner = new ProjectScanner(tempDir);
      const results = await scanner.discoverToolResultFiles("test-project", "abc-123");
      expect(results).toHaveLength(2);

      const ids = results.map((r) => r.toolUseId).sort();
      expect(ids).toContain("toolu_001");
      expect(ids).toContain("toolu_002");
    });

    it("returns empty for directory without tool-results", async () => {
      mkdirSync(join(tempDir, "test-project", "abc-123"), { recursive: true });
      const scanner = new ProjectScanner(tempDir);
      const results = await scanner.discoverToolResultFiles("test-project", "abc-123");
      expect(results).toEqual([]);
    });
  });

  // ---- readMemoryFile ----

  describe("readMemoryFile", () => {
    it("reads MEMORY.md from memory subdirectory", async () => {
      const memDir = join(tempDir, "test-project", "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Memory\n\nSome memory content.", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const content = await scanner.readMemoryFile("test-project");
      expect(content).toContain("Some memory content");
    });

    it("returns null if no MEMORY.md exists", async () => {
      mkdirSync(join(tempDir, "test-project"), { recursive: true });
      const scanner = new ProjectScanner(tempDir);
      const content = await scanner.readMemoryFile("test-project");
      expect(content).toBeNull();
    });
  });

  // ---- collectAllFiles ----

  describe("collectAllFiles", () => {
    it("collects MEMORY.md files", async () => {
      const memDir = join(tempDir, "test-project", "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Memory content here", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const files = await scanner.collectAllFiles({
        dirName: "test-project",
        name: "testapp",
        projectPath: join(tempDir, "nonexistent-source"),
        sessionCount: 0,
        hasMemory: true,
        hasClaudeMd: false,
        lastScannedAt: new Date().toISOString(),
      });

      const memFile = files.find((f) => f.fileType === "memory");
      expect(memFile).toBeDefined();
      expect(memFile!.content).toContain("Memory content");
    });

    it("collects rules files recursively from nested directories", async () => {
      // Create a project source dir with nested .claude/rules/
      const sourceDir = join(tempDir, "source-project");
      const rulesDir = join(sourceDir, ".claude", "rules");
      const nestedDir = join(rulesDir, "subdir");
      const deepDir = join(rulesDir, "subdir", "deep");
      mkdirSync(deepDir, { recursive: true });

      writeFileSync(join(rulesDir, "top-level.md"), "# Top level rule", "utf-8");
      writeFileSync(join(nestedDir, "nested.md"), "# Nested rule", "utf-8");
      writeFileSync(join(deepDir, "deep.md"), "# Deep rule", "utf-8");
      writeFileSync(join(rulesDir, "not-md.txt"), "should be skipped", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const files = await scanner.collectAllFiles({
        dirName: "test-project",
        name: "testapp",
        projectPath: sourceDir,
        sessionCount: 0,
        hasMemory: false,
        hasClaudeMd: false,
        lastScannedAt: new Date().toISOString(),
      });

      const ruleFiles = files.filter((f) => f.fileType === "rules");
      expect(ruleFiles).toHaveLength(3);

      const paths = ruleFiles.map((f) => f.relativePath).sort();
      expect(paths).toContain(".claude/rules/top-level.md");
      expect(paths).toContain(".claude/rules/subdir/nested.md");
      expect(paths).toContain(".claude/rules/subdir/deep/deep.md");
    });
  });

  // ---- readRuleFiles ----

  describe("readRuleFiles", () => {
    it("reads rules recursively and returns relative paths", async () => {
      const sourceDir = join(tempDir, "source-project");
      const rulesDir = join(sourceDir, ".claude", "rules");
      const nestedDir = join(rulesDir, "team");
      mkdirSync(nestedDir, { recursive: true });

      writeFileSync(join(rulesDir, "main.md"), "# Main rule", "utf-8");
      writeFileSync(join(nestedDir, "team-rule.md"), "# Team rule", "utf-8");

      const scanner = new ProjectScanner(tempDir);
      const rules = await scanner.readRuleFiles(sourceDir);
      expect(rules).toHaveLength(2);

      const paths = rules.map((r) => r.path).sort();
      expect(paths).toContain("main.md");
      expect(paths).toContain("team/team-rule.md");
    });

    it("returns empty array when rules directory does not exist", async () => {
      const sourceDir = join(tempDir, "no-rules-project");
      mkdirSync(sourceDir, { recursive: true });

      const scanner = new ProjectScanner(tempDir);
      const rules = await scanner.readRuleFiles(sourceDir);
      expect(rules).toEqual([]);
    });
  });
});
