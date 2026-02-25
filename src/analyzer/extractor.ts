import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Learning, LearningCategory, Session } from "../types/index.js";

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
          assistantCount++;
          // Count tool_use blocks in assistant messages
          const message = entry.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            toolUseCount += content.filter(
              (b: Record<string, unknown>) => b.type === "tool_use"
            ).length;
          }
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
