import { describe, it, expect } from "vitest";
import { redactPath, redactProject, redactSession, redactMessage, redactSubagent } from "../src/server/redact.js";
import { homedir } from "node:os";

const HOME = homedir();

describe("redactPath", () => {
  it("replaces home directory with ~", () => {
    expect(redactPath(`${HOME}/Projects/testapp`)).toBe("~/Projects/testapp");
  });

  it("replaces .claude path", () => {
    expect(redactPath(`${HOME}/.claude/projects/-Users-kevin-Projects-test`))
      .toBe("~/.claude/projects/-Users-kevin-Projects-test");
  });

  it("returns null for null input", () => {
    expect(redactPath(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(redactPath(undefined)).toBeNull();
  });

  it("leaves non-home paths unchanged", () => {
    expect(redactPath("/tmp/test")).toBe("/tmp/test");
  });

  it("handles relative paths unchanged", () => {
    expect(redactPath("relative/path")).toBe("relative/path");
  });
});

describe("redactProject", () => {
  it("redacts projectPath field", () => {
    const result = redactProject({
      name: "testapp",
      projectPath: `${HOME}/Projects/testapp`,
      sessionCount: 5,
    });
    expect(result.projectPath).toBe("~/Projects/testapp");
    expect(result.name).toBe("testapp");
    expect(result.sessionCount).toBe(5);
  });
});

describe("redactSession", () => {
  it("redacts jsonlPath field", () => {
    const result = redactSession({
      sessionId: "abc-123",
      jsonlPath: `${HOME}/.claude/projects/test/sess.jsonl`,
    });
    expect(result.jsonlPath).toBe("~/.claude/projects/test/sess.jsonl");
  });
});

describe("redactMessage", () => {
  it("redacts cwd field", () => {
    const result = redactMessage({
      uuid: "msg-1",
      cwd: `${HOME}/Projects/testapp`,
    });
    expect(result.cwd).toBe("~/Projects/testapp");
  });

  it("handles null cwd", () => {
    const result = redactMessage({ uuid: "msg-1", cwd: null });
    expect(result.cwd).toBeNull();
  });
});

describe("redactSubagent", () => {
  it("redacts jsonlPath field", () => {
    const result = redactSubagent({
      agentId: "agent-xyz",
      jsonlPath: `${HOME}/.claude/projects/test/sess/subagents/agent-xyz.jsonl`,
    });
    expect(result.jsonlPath).toBe("~/.claude/projects/test/sess/subagents/agent-xyz.jsonl");
  });
});
