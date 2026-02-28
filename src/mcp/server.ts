#!/usr/bin/env node

/**
 * MCP server for the Monitor meta-learning system.
 *
 * Exposes tools for querying patterns and learnings across all
 * Claude Code projects. Runs over stdio using JSON-RPC 2.0.
 *
 * Tools:
 * - search_learnings: Full-text search across all extracted learnings
 * - list_projects: List all discovered Claude Code projects
 * - get_project_summary: Get learnings and stats for a specific project
 * - get_stats: Get database-wide statistics
 * - search_thinking: Full-text search across thinking blocks
 * - get_recommendations: Rules-based optimization suggestions
 * - list_project_files: List documentation files for a project
 * - get_file_content: Retrieve full content of a project documentation file
 * - get_tool_success_rates: Per-tool reliability statistics
 * - get_expensive_sessions: Most expensive sessions ranked by cost
 * - get_model_breakdown: Per-model token and message statistics
 * - get_session_analytics: Full analytics for a specific session
 * - get_session_messages: Browse message metadata for a session
 * - search_messages: Full-text search across session message content
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

// ---- search_learnings ----
server.tool(
  "search_learnings",
  "Full-text search across all extracted learnings from Claude Code projects",
  {
    query: z.string().describe("Search query"),
    project: z.string().optional().describe("Filter by project name"),
    source_type: z.enum(["memory", "claude_md", "session", "rules", "agent_lessons", "skills"]).optional().describe("Filter by source type"),
    category: z.enum(["pattern", "decision", "gotcha", "convention", "bug", "architecture", "tool_usage"]).optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const results = db.search({
        query: params.query,
        limit: params.limit ?? 20,
        projectNames: params.project ? [params.project] : undefined,
        sourceTypes: params.source_type ? [params.source_type] : undefined,
        categories: params.category ? [params.category] : undefined,
      });

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const text = results
        .map((r) =>
          `[${r.learning.projectName}] (${r.learning.sourceType}/${r.learning.category})\n` +
          `  ${r.learning.sourcePath}\n` +
          `  ${r.snippet}`
        )
        .join("\n\n");

      return { content: [{ type: "text" as const, text: `${results.length} results:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- list_projects ----
server.tool(
  "list_projects",
  "List all discovered Claude Code projects with session counts and metadata",
  {},
  async () => {
    try {
      const projects = db.getProjects();

      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects found. Run 'monitor scan' first." }] };
      }

      const text = projects
        .map((p) => {
          const flags = [
            p.hasMemory ? "MEMORY" : "",
            p.hasClaudeMd ? "CLAUDE.md" : "",
          ].filter(Boolean).join(", ");
          return `${p.name} — ${p.sessionCount} sessions${flags ? ` [${flags}]` : ""}`;
        })
        .join("\n");

      return { content: [{ type: "text" as const, text: `${projects.length} projects:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to list projects: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_project_summary ----
server.tool(
  "get_project_summary",
  "Get learnings, files, and session stats for a specific project",
  {
    project: z.string().describe("Project name"),
  },
  async (params) => {
    try {
      const project = db.getProjectByName(params.project);
      if (!project) {
        return { content: [{ type: "text" as const, text: `Project "${params.project}" not found.` }], isError: true };
      }

      const learnings = db.getLearningsForProject(project.dirName);
      const files = db.getProjectFiles(project.dirName);
      const sessions = db.getSessions(project.dirName);

      const sections: string[] = [];

      sections.push(`# ${project.name}`);
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

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get project summary: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_stats ----
server.tool(
  "get_stats",
  "Get database-wide statistics including project counts, session totals, and analytics",
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- search_thinking ----
server.tool(
  "search_thinking",
  "Full-text search across Claude's thinking blocks from deep-extracted sessions",
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

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No thinking blocks found matching query." }] };
      }

      const text = results
        .map((r) =>
          `[${r.block.sessionId}] (${r.block.contentLength} chars)\n${r.snippet}`
        )
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: `${results.length} results:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Thinking search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_recommendations ----
server.tool(
  "get_recommendations",
  "Get optimization recommendations based on analytics data (cost, efficiency, reliability)",
  {},
  async () => {
    try {
      const recommendations = generateRecommendations(db);

      if (recommendations.length === 0) {
        return { content: [{ type: "text" as const, text: "No recommendations — everything looks good!" }] };
      }

      const text = recommendations
        .map((r) => {
          const icon = r.severity === "warning" ? "⚠" : "ℹ";
          return `${icon} [${r.type}] ${r.message}\n  ${r.detail}`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text: `${recommendations.length} recommendations:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get recommendations: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- list_project_files ----
server.tool(
  "list_project_files",
  "List documentation files (CLAUDE.md, rules, memory, skills, etc.) for a specific project",
  {
    project: z.string().describe("Project name"),
  },
  async (params) => {
    try {
      const project = db.getProjectByName(params.project);
      if (!project) {
        return { content: [{ type: "text" as const, text: `Project "${params.project}" not found.` }], isError: true };
      }
      const files = db.getProjectFiles(project.dirName);
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: `No files found for "${params.project}".` }] };
      }
      const text = files
        .map((f) => `${f.relativePath} (${f.fileType}, ${f.sizeBytes}B, updated ${f.lastSeenAt})`)
        .join("\n");
      return { content: [{ type: "text" as const, text: `${files.length} files:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to list files: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_file_content ----
server.tool(
  "get_file_content",
  "Retrieve the full content of a documentation file from a project (CLAUDE.md, rules, memory, etc.)",
  {
    project: z.string().describe("Project name"),
    path: z.string().describe("Relative file path (e.g. 'CLAUDE.md', '.claude/rules/scanner-trust.md')"),
  },
  async (params) => {
    try {
      const project = db.getProjectByName(params.project);
      if (!project) {
        return { content: [{ type: "text" as const, text: `Project "${params.project}" not found.` }], isError: true };
      }
      const file = db.getProjectFile(project.dirName, params.path);
      if (!file) {
        return { content: [{ type: "text" as const, text: `File "${params.path}" not found in "${params.project}".` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `# ${file.relativePath}\n\n${file.content}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get file: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_tool_success_rates ----
server.tool(
  "get_tool_success_rates",
  "Get per-tool reliability statistics: total calls, errors, and success rate",
  {},
  async () => {
    try {
      const rates = db.getToolSuccessRates();
      if (rates.length === 0) {
        return { content: [{ type: "text" as const, text: "No tool invocation data. Run 'monitor scan --deep' first." }] };
      }
      const text = rates
        .map((r) => `${r.toolName}: ${r.total} calls, ${r.errors} errors (${(r.successRate * 100).toFixed(1)}% success)`)
        .join("\n");
      return { content: [{ type: "text" as const, text: `Tool success rates:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get tool rates: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_expensive_sessions ----
server.tool(
  "get_expensive_sessions",
  "Get the most expensive sessions ranked by estimated cost",
  {
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async (params) => {
    try {
      const sessions = db.getMostExpensiveSessions(params.limit ?? 10);
      if (sessions.length === 0) {
        return { content: [{ type: "text" as const, text: "No analytics data. Run 'monitor scan --deep' first." }] };
      }
      const text = sessions
        .map((s) =>
          `$${s.estimatedCostUsd.toFixed(2)} — ${s.projectName} (${Math.round(s.durationSeconds / 60)}min, ${s.totalToolUses} tools) ${s.startedAt}`
        )
        .join("\n");
      return { content: [{ type: "text" as const, text: `Most expensive sessions:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get expensive sessions: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_model_breakdown ----
server.tool(
  "get_model_breakdown",
  "Get per-model token and message statistics across all sessions",
  {},
  async () => {
    try {
      const models = db.getModelStats();
      if (models.length === 0) {
        return { content: [{ type: "text" as const, text: "No model data. Run 'monitor scan --deep' first." }] };
      }
      const text = models
        .map((m) =>
          `${m.model}: ${m.messageCount} messages, ${m.totalInputTokens.toLocaleString()} input / ${m.totalOutputTokens.toLocaleString()} output tokens`
        )
        .join("\n");
      return { content: [{ type: "text" as const, text: `Model breakdown:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get model stats: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_session_analytics ----
server.tool(
  "get_session_analytics",
  "Get full analytics for a specific session (tokens, cost, tool breakdown, duration, models)",
  {
    session_id: z.string().describe("Session UUID"),
  },
  async (params) => {
    try {
      const analytics = db.getSessionAnalytics(params.session_id);
      if (!analytics) {
        return { content: [{ type: "text" as const, text: `No analytics for session "${params.session_id}". It may not be deep-extracted yet.` }], isError: true };
      }
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
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get analytics: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- get_session_messages ----
server.tool(
  "get_session_messages",
  "Browse message metadata for a session (type, model, tokens, timestamps — no content text)",
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
      if (messages.length === 0) {
        return { content: [{ type: "text" as const, text: `No messages found for session "${params.session_id}".` }] };
      }
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
      return { content: [{ type: "text" as const, text: `${messages.length} messages:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get messages: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---- search_messages ----
server.tool(
  "search_messages",
  "Full-text search across session message content from deep-extracted sessions",
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

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No messages found matching query." }] };
      }

      const text = results
        .map((r) => {
          const cwd = r.message.cwd ? ` cwd:${redactPath(r.message.cwd)}` : "";
          return `[${r.projectName}] ${r.message.timestamp} ${r.message.entryType}${cwd}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: `${results.length} results:\n\n${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Message search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
