#!/usr/bin/env node

/**
 * MCP server for the Monitor meta-learning system.
 *
 * Exposes 22 tools for querying patterns and learnings across all
 * Claude Code projects. Runs over stdio using JSON-RPC 2.0.
 *
 * Search tools:
 *   search_learnings, search_thinking, search_messages
 * Project tools:
 *   list_projects, get_project_summary, list_project_files, get_file_content
 * Analytics tools:
 *   get_stats, get_recommendations, get_tool_success_rates,
 *   get_expensive_sessions, get_expensive_requests, get_model_breakdown,
 *   get_cross_project_patterns, get_cost_trends, get_tool_sequences,
 *   get_anti_patterns, get_convention_drift
 * Session tools:
 *   get_session_analytics, get_session_messages, get_session_requests
 * Plan tools:
 *   get_plans
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
  "Per-tool call counts, error counts, success rates, avg duration, and avg I/O sizes. " +
    "Requires deep-extracted sessions. Use get_recommendations for actionable suggestions.",
  {},
  async () => {
    try {
      const stats = db.getToolLifecycleStats();
      if (stats.length === 0) return emptyResult("tool invocation data", DEEP_HINT);
      const text = stats
        .map((r) => {
          const duration = r.avgDurationMs !== null ? ` avg ${Math.round(r.avgDurationMs)}ms` : "";
          const io = r.avgInputBytes > 0 || r.avgResultBytes > 0
            ? ` (${Math.round(r.avgInputBytes)}B in, ${Math.round(r.avgResultBytes)}B out)`
            : "";
          return `${r.toolName}: ${r.total} calls, ${r.errors} errors (${(r.successRate * 100).toFixed(1)}% success)${duration}${io}`;
        })
        .join("\n");
      return textResult(`Tool lifecycle stats:\n\n${text}`);
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

// ---- get_session_requests ----
server.tool(
  "get_session_requests",
  "Per-request cost breakdown for a session: each API request with model, tokens, cost, tool count. " +
    "Use get_expensive_sessions to find session IDs. Requires deep-extracted sessions.",
  {
    session_id: z.string().describe("Session UUID"),
  },
  async (params) => {
    try {
      const requests = db.getSessionApiRequests(params.session_id);
      if (requests.length === 0) return emptyResult("API requests", DEEP_HINT);
      const text = requests
        .map((r) =>
          `#${r.requestIndex} ${r.model} $${r.estimatedCostUsd.toFixed(4)} ` +
          `(${r.inputTokens.toLocaleString()}in/${r.outputTokens.toLocaleString()}out) ` +
          `${r.toolUseCount} tools, ${r.thinkingCharCount.toLocaleString()} thinking chars ` +
          `[${r.stopReason ?? "?"}]`
        )
        .join("\n");
      return textResult(`${requests.length} API requests:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get session requests", err);
    }
  }
);

// ---- get_expensive_requests ----
server.tool(
  "get_expensive_requests",
  "Most expensive individual API requests across all sessions. " +
    "Identifies which single requests consumed the most tokens/cost. " +
    "Requires deep-extracted sessions.",
  {
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async (params) => {
    try {
      const requests = db.getMostExpensiveRequests(params.limit ?? 10);
      if (requests.length === 0) return emptyResult("API requests", DEEP_HINT);
      const text = requests
        .map((r) =>
          `$${r.estimatedCostUsd.toFixed(4)} — ${r.projectName} ${r.model} ` +
          `(${r.inputTokens.toLocaleString()}in/${r.outputTokens.toLocaleString()}out) ` +
          `${r.toolUseCount} tools [${r.stopReason ?? "?"}] ${r.timestamp}`
        )
        .join("\n");
      return textResult(`Most expensive requests:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get expensive requests", err);
    }
  }
);

// ---- get_plans ----
server.tool(
  "get_plans",
  "Retrieve implementation plans from ExitPlanMode tool invocations with full content (up to 50K chars). " +
    "Useful for understanding design decisions, seeing how tasks were planned, and reusing patterns. " +
    "Pass session_id to get plans for a specific session, or omit for all plans. " +
    "Requires deep-extracted sessions.",
  {
    session_id: z.string().optional().describe("Session UUID (omit for all plans)"),
    limit: z.number().optional().describe("Max results when listing all plans (default 20)"),
  },
  async (params) => {
    try {
      if (params.session_id) {
        const plans = db.getSessionPlans(params.session_id);
        if (plans.length === 0) return emptyResult("plans", DEEP_HINT);
        const text = plans
          .map((p) => `--- Plan (${p.contentLength} chars, ${p.timestamp}) ---\n${p.planContent}`)
          .join("\n\n");
        return textResult(`${plans.length} plan(s) in session:\n\n${text}`);
      }
      const plans = db.getAllPlans(params.limit ?? 20);
      if (plans.length === 0) return emptyResult("plans", DEEP_HINT);
      const text = plans
        .map((p) =>
          `[${p.projectName}] ${p.timestamp} (${p.contentLength} chars)\n` +
          `Session: ${p.sessionId}\n` +
          `${p.planContent.slice(0, 500)}${p.contentLength > 500 ? "..." : ""}`
        )
        .join("\n\n---\n\n");
      return textResult(`${plans.length} plans:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get plans", err);
    }
  }
);

// ---- get_cross_project_patterns ----
server.tool(
  "get_cross_project_patterns",
  "Discover conventions and patterns that appear across 3+ projects. " +
    "Useful for identifying universal best practices, common conventions, and shared architecture decisions. " +
    "Based on learnings extracted from CLAUDE.md, MEMORY.md, and rules files.",
  {
    min_projects: z.number().optional().describe("Minimum number of projects sharing the pattern (default 3)"),
  },
  async (params) => {
    try {
      const patterns = db.getCrossProjectPatterns(params.min_projects ?? 3);
      if (patterns.length === 0) return emptyResult("cross-project patterns", "Need learnings from 3+ projects.");
      const text = patterns
        .map((p) =>
          `[${p.projectCount} projects: ${p.projects}] (${p.category})\n  ${p.content.slice(0, 300)}`
        )
        .join("\n\n");
      return textResult(`${patterns.length} cross-project patterns:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get patterns", err);
    }
  }
);

// ---- get_cost_trends ----
server.tool(
  "get_cost_trends",
  "Daily cost time series from API request data. Shows cost per day per project. " +
    "Useful for spotting cost spikes, tracking spend over time, and comparing project costs. " +
    "Requires deep-extracted sessions with api_requests data.",
  {
    days: z.number().optional().describe("Number of days to look back (default 30)"),
  },
  async (params) => {
    try {
      const trends = db.getCostTrends(params.days ?? 30);
      if (trends.length === 0) return emptyResult("cost trend data", DEEP_HINT);

      // Group by day for readable output
      const byDay = new Map<string, Array<{ project: string; cost: number; requests: number }>>();
      for (const t of trends) {
        const existing = byDay.get(t.day) ?? [];
        existing.push({ project: t.projectName, cost: t.dailyCost, requests: t.requestCount });
        byDay.set(t.day, existing);
      }

      const lines: string[] = [];
      for (const [day, entries] of byDay) {
        const totalCost = entries.reduce((s, e) => s + e.cost, 0);
        lines.push(`${day} — $${totalCost.toFixed(4)} total`);
        for (const e of entries) {
          lines.push(`  ${e.project}: $${e.cost.toFixed(4)} (${e.requests} requests)`);
        }
      }

      return textResult(`Cost trends:\n\n${lines.join("\n")}`);
    } catch (err) {
      return errorResult("Failed to get cost trends", err);
    }
  }
);

// ---- get_tool_sequences ----
server.tool(
  "get_tool_sequences",
  "Most common consecutive tool call pairs across all sessions. " +
    "Reveals workflow patterns: e.g., Read→Edit (read-then-modify), Glob→Read (find-then-read). " +
    "Useful for understanding how tools are typically combined. " +
    "Requires deep-extracted sessions.",
  {
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const sequences = db.getToolSequences(params.limit ?? 20);
      if (sequences.length === 0) return emptyResult("tool sequence data", DEEP_HINT);
      const text = sequences
        .map((s) => `${s.toolA} → ${s.toolB}: ${s.frequency} times`)
        .join("\n");
      return textResult(`Tool sequence patterns:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get tool sequences", err);
    }
  }
);

// ---- get_anti_patterns ----
server.tool(
  "get_anti_patterns",
  "Sessions with high error rates (>3 errors) or unusually high cost (>3x average). " +
    "Useful for identifying problematic sessions and common failure modes. " +
    "Requires deep-extracted sessions.",
  {
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      const antiPatterns = db.getAntiPatterns(params.limit ?? 20);
      if (antiPatterns.length === 0) return textResult("No anti-patterns detected — all sessions look healthy.");
      const text = antiPatterns
        .map((a) =>
          `${a.projectName} — $${a.estimatedCostUsd.toFixed(2)}, ${a.errorCount} errors ` +
          `(${(a.errorRate * 100).toFixed(1)}% error rate), ${a.totalToolUses} tools, ` +
          `${Math.round(a.durationSeconds / 60)}min ${a.startedAt}`
        )
        .join("\n");
      return textResult(`${antiPatterns.length} problematic sessions:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get anti-patterns", err);
    }
  }
);

// ---- get_convention_drift ----
server.tool(
  "get_convention_drift",
  "Track how project conventions evolve: CLAUDE.md, rules, and MEMORY.md files that have changed over time. " +
    "Shows version counts and date ranges. Use get_file_content to see current content " +
    "or list version history via the API.",
  {},
  async () => {
    try {
      const drift = db.getConventionDrift();
      if (drift.length === 0) return textResult("No convention drift detected — all files are single-version.");
      const text = drift
        .map((d) =>
          `${d.projectName} — ${d.relativePath} (${d.fileType})\n` +
          `  ${d.versionCount} versions, ${d.currentSizeBytes}B, ${d.firstSeen} → ${d.lastSeen}`
        )
        .join("\n\n");
      return textResult(`${drift.length} files with version history:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get convention drift", err);
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
