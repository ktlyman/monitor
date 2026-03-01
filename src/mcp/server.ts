#!/usr/bin/env node

/**
 * MCP server for the Monitor meta-learning system.
 *
 * Exposes 14 tools for querying patterns and learnings across all
 * Claude Code projects. Runs over stdio using JSON-RPC 2.0.
 *
 * Search tools:
 *   search_learnings, search_thinking, search_messages
 * Project tools:
 *   list_projects, get_project_summary, list_project_files, get_file_content
 * Analytics tools:
 *   get_stats, get_recommendations, get_tool_success_rates,
 *   get_expensive_sessions, get_model_breakdown
 * Session tools:
 *   get_session_analytics, get_session_messages
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MonitorDatabase } from "../storage/database.js";
import { generateRecommendations } from "../analyzer/recommendations.js";
import { redactPath } from "../server/redact.js";

const DB_PATH = process.env.DB_PATH ?? "monitor.db";

const db = new MonitorDatabase(DB_PATH);
const server = new McpServer({ name: "monitor", version: "0.1.0" });

// ---- Response helpers ----

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `${context}: ${msg}` }], isError: true as const };
}

function notFound(entity: string, id: string) {
  return textResult(`No ${entity} found matching "${id}".`);
}

function emptyResult(entity: string, hint?: string) {
  return textResult(hint ? `No ${entity} found. ${hint}` : `No ${entity} found.`);
}

const DEEP_HINT = "Requires deep-extracted sessions — run 'monitor scan --deep'.";

// ---- search_learnings ----
server.tool(
  "search_learnings",
  "Search learnings extracted from MEMORY.md (memory), CLAUDE.md (claude_md), " +
    ".claude/rules/ (rules), and agent-lessons.md (agent_lessons) across all projects. " +
    "Returns project name, source, and matching snippet. " +
    "For skills/commands, use list_project_files + get_file_content instead. " +
    "Complements search_thinking (reasoning) and search_messages (conversation content).",
  {
    query: z.string().describe("Search query"),
    project: z.string().optional().describe("Project directory name or display name (use list_projects to see available values)"),
    source_type: z.enum(["memory", "claude_md", "rules", "agent_lessons"]).optional().describe("Filter by source type"),
    category: z.enum(["pattern", "decision", "gotcha", "convention", "bug", "architecture"]).optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const resolved = params.project ? db.resolveProject(params.project) : null;
      const results = db.search({
        query: params.query,
        limit: params.limit ?? 20,
        projectDirNames: resolved ? [resolved.dirName] : undefined,
        projectNames: !resolved && params.project ? [params.project] : undefined,
        sourceTypes: params.source_type ? [params.source_type] : undefined,
        categories: params.category ? [params.category] : undefined,
      });

      if (results.length === 0) return emptyResult("learnings");

      const text = results
        .map((r) =>
          `[${r.learning.projectName}] (${r.learning.sourceType}/${r.learning.category})\n` +
          `  ${redactPath(r.learning.sourcePath) ?? r.learning.sourcePath}\n` +
          `  ${r.snippet}`
        )
        .join("\n\n");

      return textResult(`${results.length} results:\n\n${text}`);
    } catch (err) {
      return errorResult("Learning search failed", err);
    }
  }
);

// ---- list_projects ----
server.tool(
  "list_projects",
  "List all discovered projects with session counts and documentation flags (hasMemory, hasClaudeMd). " +
    "Use get_project_summary for details or list_project_files to browse a project's docs.",
  {},
  async () => {
    try {
      const projects = db.getProjects();
      if (projects.length === 0) return emptyResult("projects", "Run 'monitor scan' first.");

      const text = projects
        .map((p) => {
          const flags = [
            p.hasMemory ? "MEMORY" : "",
            p.hasClaudeMd ? "CLAUDE.md" : "",
          ].filter(Boolean).join(", ");
          return `${p.name} (${p.dirName}) — ${p.sessionCount} sessions${flags ? ` [${flags}]` : ""}`;
        })
        .join("\n");

      return textResult(`${projects.length} projects:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to list projects", err);
    }
  }
);

// ---- get_project_summary ----
server.tool(
  "get_project_summary",
  "Get learnings, documentation files, and session stats for a project. " +
    "Use get_file_content to read specific files, or get_session_analytics for session details.",
  {
    project: z.string().describe("Project directory name or display name (use list_projects to see available values)"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);

      const learnings = db.getLearningsForProject(project.dirName);
      const files = db.getProjectFiles(project.dirName);
      const sessions = db.getSessions(project.dirName);

      const sections: string[] = [];

      sections.push(`# ${project.name} (${project.dirName})`);
      sections.push(`Path: ${redactPath(project.projectPath) ?? "unknown"}`);
      sections.push(`Sessions: ${sessions.length}, Learnings: ${learnings.length}, Files: ${files.length}`);

      if (learnings.length > 0) {
        sections.push("\n## Learnings");
        for (const l of learnings) {
          sections.push(`- [${l.sourceType}/${l.category}] ${l.content.slice(0, 200)}`);
        }
      }

      if (files.length > 0) {
        sections.push("\n## Files");
        for (const f of files) {
          sections.push(`- ${f.relativePath} (${f.fileType}, ${f.sizeBytes}B)`);
        }
      }

      return textResult(sections.join("\n"));
    } catch (err) {
      return errorResult("Failed to get project summary", err);
    }
  }
);

// ---- get_stats ----
server.tool(
  "get_stats",
  "Database-wide statistics: project counts, session totals, learning breakdowns, and analytics summary. " +
    "Good starting point for understanding what data is available.",
  {},
  async () => {
    try {
      const stats = db.getStats();

      const lines = [
        `Projects: ${stats.totalProjects}`,
        `Sessions: ${stats.totalSessions}`,
        `Learnings: ${stats.totalLearnings}`,
      ];

      if (Object.keys(stats.learningsBySource).length > 0) {
        lines.push("\nBy source:");
        for (const [source, count] of Object.entries(stats.learningsBySource)) {
          lines.push(`  ${source}: ${count}`);
        }
      }

      if (Object.keys(stats.learningsByCategory).length > 0) {
        lines.push("\nBy category:");
        for (const [cat, count] of Object.entries(stats.learningsByCategory)) {
          lines.push(`  ${cat}: ${count}`);
        }
      }

      if (stats.analytics) {
        const a = stats.analytics;
        lines.push("\nAnalytics:");
        lines.push(`  Sessions deep-extracted: ${a.sessionsDeepExtracted}`);
        lines.push(`  Total messages: ${a.totalMessages}`);
        lines.push(`  Total tool invocations: ${a.totalToolInvocations}`);
        lines.push(`  Total thinking blocks: ${a.totalThinkingBlocks}`);
        lines.push(`  Estimated total cost: $${a.totalEstimatedCostUsd.toFixed(2)}`);
      }

      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult("Failed to get stats", err);
    }
  }
);

// ---- search_thinking ----
server.tool(
  "search_thinking",
  "Full-text search across Claude's thinking/reasoning blocks. " +
    "Requires deep-extracted sessions. " +
    "Complements search_learnings (knowledge) and search_messages (conversation content).",
  {
    query: z.string().describe("Search query"),
    session_id: z.string().optional().describe("Filter by session ID"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const results = db.searchThinking(params.query, {
        sessionId: params.session_id,
        limit: params.limit ?? 20,
      });

      if (results.length === 0) return emptyResult("thinking blocks", DEEP_HINT);

      const text = results
        .map((r) =>
          `[${r.block.sessionId}] (${r.block.contentLength} chars)\n${r.snippet}`
        )
        .join("\n\n---\n\n");

      return textResult(`${results.length} results:\n\n${text}`);
    } catch (err) {
      return errorResult("Thinking search failed", err);
    }
  }
);

// ---- get_recommendations ----
server.tool(
  "get_recommendations",
  "Actionable optimization suggestions based on tool reliability, session cost, and cache efficiency. " +
    "Requires deep-extracted sessions. Based on data from get_tool_success_rates and get_expensive_sessions.",
  {},
  async () => {
    try {
      const recommendations = generateRecommendations(db);

      if (recommendations.length === 0) {
        return textResult("No recommendations — everything looks good!");
      }

      const text = recommendations
        .map((r) => {
          const icon = r.severity === "warning" ? "⚠" : "ℹ";
          return `${icon} [${r.type}] ${r.message}\n  ${r.detail}`;
        })
        .join("\n\n");

      return textResult(`${recommendations.length} recommendations:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get recommendations", err);
    }
  }
);

// ---- list_project_files ----
server.tool(
  "list_project_files",
  "List documentation files for a project (CLAUDE.md, rules, memory, skills, etc.). " +
    "Use get_file_content to read a specific file's contents.",
  {
    project: z.string().describe("Project directory name or display name (use list_projects to see available values)"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);
      const files = db.getProjectFiles(project.dirName);
      if (files.length === 0) return emptyResult("files", `No docs collected for "${params.project}".`);
      const text = files
        .map((f) => `${f.relativePath} (${f.fileType}, ${f.sizeBytes}B, updated ${f.lastSeenAt})`)
        .join("\n");
      return textResult(`${files.length} files:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to list files", err);
    }
  }
);

// ---- get_file_content ----
server.tool(
  "get_file_content",
  "Retrieve the full content of a documentation file from a project. " +
    "Use list_project_files to discover available paths.",
  {
    project: z.string().describe("Project directory name or display name (use list_projects to see available values)"),
    path: z.string().describe("Relative file path (e.g. 'CLAUDE.md', '.claude/rules/scanner-trust.md')"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);
      const file = db.getProjectFile(project.dirName, params.path);
      if (!file) return notFound("file", params.path);
      return textResult(`# ${file.relativePath}\n\n${file.content}`);
    } catch (err) {
      return errorResult("Failed to get file", err);
    }
  }
);

// ---- get_tool_success_rates ----
server.tool(
  "get_tool_success_rates",
  "Per-tool call counts, error counts, and success rates across all sessions. " +
    "Requires deep-extracted sessions. Use get_recommendations for actionable suggestions.",
  {},
  async () => {
    try {
      const rates = db.getToolSuccessRates();
      if (rates.length === 0) return emptyResult("tool invocation data", DEEP_HINT);
      const text = rates
        .map((r) => `${r.toolName}: ${r.total} calls, ${r.errors} errors (${(r.successRate * 100).toFixed(1)}% success)`)
        .join("\n");
      return textResult(`Tool success rates:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get tool rates", err);
    }
  }
);

// ---- get_expensive_sessions ----
server.tool(
  "get_expensive_sessions",
  "Most expensive sessions ranked by estimated API cost (descending). " +
    "Requires deep-extracted sessions. Use get_session_analytics for full details on a session.",
  {
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async (params) => {
    try {
      const sessions = db.getMostExpensiveSessions(params.limit ?? 10);
      if (sessions.length === 0) return emptyResult("analytics data", DEEP_HINT);
      const text = sessions
        .map((s) =>
          `$${s.estimatedCostUsd.toFixed(2)} — ${s.projectName} (${Math.round(s.durationSeconds / 60)}min, ${s.totalToolUses} tools) ${s.startedAt}`
        )
        .join("\n");
      return textResult(`Most expensive sessions:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get expensive sessions", err);
    }
  }
);

// ---- get_model_breakdown ----
server.tool(
  "get_model_breakdown",
  "Per-model token and message statistics across all deep-extracted sessions. " +
    "Shows which Claude models were used and their token volumes.",
  {},
  async () => {
    try {
      const models = db.getModelStats();
      if (models.length === 0) return emptyResult("model data", DEEP_HINT);
      const text = models
        .map((m) =>
          `${m.model}: ${m.messageCount} messages, ${m.totalInputTokens.toLocaleString()} input / ${m.totalOutputTokens.toLocaleString()} output tokens`
        )
        .join("\n");
      return textResult(`Model breakdown:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get model stats", err);
    }
  }
);

// ---- get_session_analytics ----
server.tool(
  "get_session_analytics",
  "Full analytics for a specific session: tokens, cost, tool breakdown, duration, and models. " +
    "Use get_expensive_sessions to find session IDs, or get_session_messages to browse messages.",
  {
    session_id: z.string().describe("Session UUID"),
  },
  async (params) => {
    try {
      const analytics = db.getSessionAnalytics(params.session_id);
      if (!analytics) return notFound("analytics for session", params.session_id);
      const lines = [
        `Session: ${analytics.sessionId}`,
        `Cost: $${analytics.estimatedCostUsd.toFixed(4)}`,
        `Duration: ${Math.round(analytics.durationSeconds / 60)} minutes`,
        `Models: ${analytics.models}`,
        `Input tokens: ${analytics.totalInputTokens.toLocaleString()}`,
        `Output tokens: ${analytics.totalOutputTokens.toLocaleString()}`,
        `Cache creation: ${analytics.totalCacheCreationTokens.toLocaleString()}`,
        `Cache read: ${analytics.totalCacheReadTokens.toLocaleString()}`,
        `API requests: ${analytics.apiRequestCount}`,
        `Tool uses: ${analytics.totalToolUses} (${analytics.errorCount} errors)`,
        `Thinking blocks: ${analytics.thinkingBlockCount} (${analytics.thinkingCharCount.toLocaleString()} chars)`,
        `Subagents: ${analytics.subagentCount}`,
      ];
      if (Object.keys(analytics.toolBreakdown).length > 0) {
        lines.push("\nTool breakdown:");
        for (const [name, count] of Object.entries(analytics.toolBreakdown).sort((a, b) => (b[1] as number) - (a[1] as number))) {
          lines.push(`  ${name}: ${count}`);
        }
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult("Failed to get analytics", err);
    }
  }
);

// ---- get_session_messages ----
server.tool(
  "get_session_messages",
  "Browse message metadata for a session: type, model, token counts, and timestamps. " +
    "Use get_session_analytics for aggregate stats, or search_messages to find specific content.",
  {
    session_id: z.string().describe("Session UUID"),
    entry_type: z.enum(["user", "assistant", "system"]).optional().describe("Filter by message type"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async (params) => {
    try {
      const messages = db.getSessionMessages(params.session_id, {
        entryType: params.entry_type,
        limit: params.limit ?? 50,
      });
      if (messages.length === 0) return emptyResult("messages", `No messages for session "${params.session_id}".`);
      const text = messages
        .map((m) => {
          const tokens = m.inputTokens + m.outputTokens > 0
            ? ` (${m.inputTokens}in/${m.outputTokens}out)`
            : "";
          const model = m.model ? ` [${m.model}]` : "";
          const cwd = m.cwd ? ` cwd:${redactPath(m.cwd)}` : "";
          return `${m.timestamp} ${m.entryType}${model}${tokens}${cwd}`;
        })
        .join("\n");
      return textResult(`${messages.length} messages:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get messages", err);
    }
  }
);

// ---- search_messages ----
server.tool(
  "search_messages",
  "Full-text search across conversation content from deep-extracted sessions. " +
    "Complements search_learnings (knowledge) and search_thinking (reasoning).",
  {
    query: z.string().describe("Search query"),
    session_id: z.string().optional().describe("Filter by session ID"),
    entry_type: z.enum(["user", "assistant", "system"]).optional().describe("Filter by message type"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const results = db.searchMessages(params.query, {
        sessionId: params.session_id,
        entryType: params.entry_type,
        limit: params.limit ?? 20,
      });

      if (results.length === 0) return emptyResult("messages", DEEP_HINT);

      const text = results
        .map((r) => {
          const cwd = r.message.cwd ? ` cwd:${redactPath(r.message.cwd)}` : "";
          return `[${r.projectName}] ${r.message.timestamp} ${r.message.entryType}${cwd}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");

      return textResult(`${results.length} results:\n\n${text}`);
    } catch (err) {
      return errorResult("Message search failed", err);
    }
  }
);

// ---- Start server ----
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Monitor MCP server running");
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
