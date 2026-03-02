#!/usr/bin/env node

/**
 * MCP server for the Monitor meta-learning system.
 *
 * Exposes 30 tools, MCP resources, and prompts for querying patterns
 * and learnings across all Claude Code projects. Runs over stdio using JSON-RPC 2.0.
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
 * Active intelligence tools:
 *   start_task, add_note, get_notes, create_runbook, list_runbooks,
 *   get_runbook, get_permission_profile, get_memory_health
 * Resources:
 *   monitor://projects/{project}/claude-md, monitor://projects/{project}/memory
 * Prompts:
 *   project-brief, session-review
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// ---- MCP Resources ----

// Dynamic resource: project CLAUDE.md
server.resource(
  "project-claude-md",
  new ResourceTemplate("monitor://projects/{project}/claude-md", { list: undefined }),
  { description: "CLAUDE.md file content for a project", mimeType: "text/markdown" },
  async (uri, variables) => {
    const project = db.resolveProject(variables.project as string);
    if (!project) return { contents: [{ uri: uri.href, text: "Project not found." }] };
    const file = db.getProjectFile(project.dirName, "CLAUDE.md");
    if (!file) return { contents: [{ uri: uri.href, text: "No CLAUDE.md found." }] };
    return { contents: [{ uri: uri.href, text: file.content, mimeType: "text/markdown" }] };
  }
);

// Dynamic resource: project MEMORY.md
server.resource(
  "project-memory",
  new ResourceTemplate("monitor://projects/{project}/memory", { list: undefined }),
  { description: "MEMORY.md file content for a project", mimeType: "text/markdown" },
  async (uri, variables) => {
    const project = db.resolveProject(variables.project as string);
    if (!project) return { contents: [{ uri: uri.href, text: "Project not found." }] };
    const files = db.getProjectFiles(project.dirName);
    const memFile = files.find((f) => f.fileType === "memory");
    if (!memFile) return { contents: [{ uri: uri.href, text: "No MEMORY.md found." }] };
    return { contents: [{ uri: uri.href, text: memFile.content, mimeType: "text/markdown" }] };
  }
);

// ---- MCP Prompts ----

server.prompt(
  "project-brief",
  "Generate a contextual briefing for a project — learnings, gotchas, patterns, and recent issues.",
  { project: z.string().describe("Project directory name or display name") },
  async (args) => {
    const project = db.resolveProject(args.project);
    if (!project) return { messages: [{ role: "user", content: { type: "text", text: `Project "${args.project}" not found.` } }] };
    const brief = db.getTaskBrief(project.dirName);

    const sections: string[] = [`# Project Brief: ${project.name}`];

    if (brief.learnings.length > 0) {
      sections.push("\n## Learnings");
      for (const l of brief.learnings.slice(0, 20)) {
        sections.push(`- [${l.sourceType}/${l.category}] ${l.content.slice(0, 200)}`);
      }
    }

    if (brief.recentAntiPatterns.length > 0) {
      sections.push("\n## Recent Issues");
      for (const a of brief.recentAntiPatterns) {
        sections.push(`- Session ${a.sessionId.slice(0, 8)}... — ${a.errorCount} errors, $${a.estimatedCostUsd.toFixed(2)} (${a.startedAt})`);
      }
    }

    if (brief.topToolSequences.length > 0) {
      sections.push("\n## Common Tool Patterns");
      for (const s of brief.topToolSequences) {
        sections.push(`- ${s.toolA} → ${s.toolB}: ${s.frequency}x`);
      }
    }

    if (brief.notes.length > 0) {
      sections.push("\n## Active Notes");
      for (const n of brief.notes.slice(0, 10)) {
        sections.push(`- [${n.category}] ${n.content.slice(0, 200)}`);
      }
    }

    if (brief.runbooks.length > 0) {
      sections.push("\n## Available Runbooks");
      for (const r of brief.runbooks) {
        sections.push(`- **${r.title}**: ${r.description.slice(0, 150)}`);
      }
    }

    return { messages: [{ role: "user", content: { type: "text", text: sections.join("\n") } }] };
  }
);

server.prompt(
  "session-review",
  "Review a session's analytics, cost, and tool usage for retrospective analysis.",
  { session_id: z.string().describe("Session UUID to review") },
  async (args) => {
    const analytics = db.getSessionAnalytics(args.session_id);
    if (!analytics) return { messages: [{ role: "user", content: { type: "text", text: `No analytics found for session "${args.session_id}".` } }] };

    const requests = db.getSessionApiRequests(args.session_id);
    const plans = db.getSessionPlans(args.session_id);

    const sections: string[] = [
      `# Session Review: ${args.session_id}`,
      `\nCost: $${analytics.estimatedCostUsd.toFixed(4)} | Duration: ${Math.round(analytics.durationSeconds / 60)}min | Models: ${analytics.models}`,
      `API requests: ${analytics.apiRequestCount} | Tool uses: ${analytics.totalToolUses} (${analytics.errorCount} errors)`,
      `Thinking: ${analytics.thinkingBlockCount} blocks, ${analytics.thinkingCharCount.toLocaleString()} chars`,
    ];

    if (Object.keys(analytics.toolBreakdown).length > 0) {
      sections.push("\n## Tool Breakdown");
      for (const [name, count] of Object.entries(analytics.toolBreakdown).sort((a, b) => (b[1] as number) - (a[1] as number))) {
        sections.push(`- ${name}: ${count}`);
      }
    }

    if (requests.length > 0) {
      sections.push("\n## Top 5 Expensive Requests");
      const sorted = [...requests].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd).slice(0, 5);
      for (const r of sorted) {
        sections.push(`- #${r.requestIndex} ${r.model} $${r.estimatedCostUsd.toFixed(4)} (${r.inputTokens.toLocaleString()}in/${r.outputTokens.toLocaleString()}out) [${r.stopReason ?? "?"}]`);
      }
    }

    if (plans.length > 0) {
      sections.push("\n## Plans Used");
      for (const p of plans) {
        sections.push(`- Plan (${p.contentLength} chars): ${p.planContent.slice(0, 300)}...`);
      }
    }

    sections.push("\n\nProvide a retrospective analysis: What went well? What could be improved? Any anti-patterns observed?");

    return { messages: [{ role: "user", content: { type: "text", text: sections.join("\n") } }] };
  }
);

// ---- start_task ----
server.tool(
  "start_task",
  "Get a contextual brief before starting work on a project. " +
    "Returns learnings, recent issues, common tool patterns, active notes, and relevant runbooks. " +
    "Call this at the beginning of a session to understand the project context.",
  {
    project: z.string().describe("Project directory name or display name"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);

      const brief = db.getTaskBrief(project.dirName);
      const sections: string[] = [`# Task Brief: ${project.name} (${project.dirName})`];

      // Learnings grouped by category
      if (brief.learnings.length > 0) {
        const byCategory = new Map<string, string[]>();
        for (const l of brief.learnings) {
          const list = byCategory.get(l.category) ?? [];
          list.push(l.content.slice(0, 300));
          byCategory.set(l.category, list);
        }
        sections.push("\n## Project Knowledge");
        for (const [cat, items] of byCategory) {
          sections.push(`\n### ${cat}`);
          for (const item of items.slice(0, 5)) {
            sections.push(`- ${item}`);
          }
          if (items.length > 5) sections.push(`  (+ ${items.length - 5} more)`);
        }
      }

      if (brief.recentAntiPatterns.length > 0) {
        sections.push("\n## Recent Issues (avoid these)");
        for (const a of brief.recentAntiPatterns) {
          sections.push(`- ${a.errorCount} errors, $${a.estimatedCostUsd.toFixed(2)} (${a.startedAt})`);
        }
      }

      if (brief.topToolSequences.length > 0) {
        sections.push("\n## Common Workflows");
        for (const s of brief.topToolSequences) {
          sections.push(`- ${s.toolA} → ${s.toolB}: ${s.frequency}x`);
        }
      }

      if (brief.notes.length > 0) {
        sections.push("\n## Notes");
        for (const n of brief.notes.slice(0, 10)) {
          sections.push(`- [${n.category}] ${n.content.slice(0, 300)}`);
        }
      }

      if (brief.runbooks.length > 0) {
        sections.push("\n## Runbooks");
        for (const r of brief.runbooks) {
          sections.push(`- **${r.title}** — ${r.description}`);
        }
      }

      return textResult(sections.join("\n"));
    } catch (err) {
      return errorResult("Failed to generate task brief", err);
    }
  }
);

// ---- add_note ----
server.tool(
  "add_note",
  "Record an observation, decision, outcome, or todo for a project or session. " +
    "Use this to capture knowledge as you work — it persists across sessions. " +
    "Notes appear in start_task briefs and project summaries.",
  {
    project: z.string().describe("Project directory name or display name"),
    content: z.string().describe("Note content"),
    category: z.enum(["observation", "decision", "outcome", "todo"]).optional().describe("Note category (default: observation)"),
    session_id: z.string().optional().describe("Attach to a specific session (optional)"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);

      const id = db.insertNote({
        projectDirName: project.dirName,
        sessionId: params.session_id ?? null,
        category: params.category ?? "observation",
        content: params.content,
        createdAt: new Date().toISOString(),
      });

      return textResult(`Note #${id} saved to ${project.name} [${params.category ?? "observation"}].`);
    } catch (err) {
      return errorResult("Failed to add note", err);
    }
  }
);

// ---- get_notes ----
server.tool(
  "get_notes",
  "Retrieve notes for a project or across all projects. " +
    "Notes are agent-authored observations, decisions, outcomes, and todos.",
  {
    project: z.string().optional().describe("Project directory name or display name (omit for all)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    try {
      if (params.project) {
        const project = db.resolveProject(params.project);
        if (!project) return notFound("project", params.project);
        const notes = db.getProjectNotes(project.dirName);
        if (notes.length === 0) return emptyResult("notes");
        const text = notes.slice(0, params.limit ?? 20)
          .map((n) => `#${n.id} [${n.category}] ${n.createdAt}\n  ${n.content.slice(0, 500)}`)
          .join("\n\n");
        return textResult(`${notes.length} notes:\n\n${text}`);
      }
      const notes = db.getAllNotes(params.limit ?? 20);
      if (notes.length === 0) return emptyResult("notes");
      const text = notes
        .map((n) => `#${n.id} [${n.projectName}] [${n.category}] ${n.createdAt}\n  ${n.content.slice(0, 500)}`)
        .join("\n\n");
      return textResult(`${notes.length} notes:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to get notes", err);
    }
  }
);

// ---- create_runbook ----
server.tool(
  "create_runbook",
  "Create a reusable runbook — a documented sequence of steps for a common task. " +
    "Runbooks appear in start_task briefs and can be shared across projects.",
  {
    title: z.string().describe("Runbook title"),
    description: z.string().describe("When/why to use this runbook"),
    steps: z.string().describe("Markdown-formatted steps"),
    project: z.string().optional().describe("Project (omit for cross-project runbook)"),
    tags: z.string().optional().describe("Comma-separated tags"),
  },
  async (params) => {
    try {
      let projectDirName: string | null = null;
      if (params.project) {
        const project = db.resolveProject(params.project);
        if (!project) return notFound("project", params.project);
        projectDirName = project.dirName;
      }

      const now = new Date().toISOString();
      const id = db.insertRunbook({
        title: params.title,
        projectDirName,
        description: params.description,
        steps: params.steps,
        source: "manual",
        tags: params.tags ?? "",
        createdAt: now,
        updatedAt: now,
      });

      return textResult(`Runbook #${id} "${params.title}" created.`);
    } catch (err) {
      return errorResult("Failed to create runbook", err);
    }
  }
);

// ---- list_runbooks ----
server.tool(
  "list_runbooks",
  "List all runbooks, optionally filtered by project. " +
    "Runbooks are reusable step sequences for common tasks.",
  {
    project: z.string().optional().describe("Filter by project (omit for all)"),
  },
  async (params) => {
    try {
      let projectDirName: string | undefined;
      if (params.project) {
        const project = db.resolveProject(params.project);
        if (!project) return notFound("project", params.project);
        projectDirName = project.dirName;
      }
      const runbooks = db.getRunbooks(projectDirName);
      if (runbooks.length === 0) return emptyResult("runbooks");
      const text = runbooks
        .map((r) => {
          const scope = r.projectDirName ? `[${r.projectDirName}]` : "[cross-project]";
          return `#${r.id} ${scope} **${r.title}**\n  ${r.description.slice(0, 200)}${r.tags ? `\n  Tags: ${r.tags}` : ""}`;
        })
        .join("\n\n");
      return textResult(`${runbooks.length} runbooks:\n\n${text}`);
    } catch (err) {
      return errorResult("Failed to list runbooks", err);
    }
  }
);

// ---- get_runbook ----
server.tool(
  "get_runbook",
  "Get full details of a runbook including all steps. " +
    "Use list_runbooks to find runbook IDs.",
  {
    id: z.number().describe("Runbook ID"),
  },
  async (params) => {
    try {
      const runbook = db.getRunbook(params.id);
      if (!runbook) return notFound("runbook", String(params.id));
      const scope = runbook.projectDirName ?? "cross-project";
      return textResult(
        `# ${runbook.title}\n\nScope: ${scope} | Source: ${runbook.source} | Tags: ${runbook.tags || "(none)"}\n` +
        `Created: ${runbook.createdAt} | Updated: ${runbook.updatedAt}\n\n` +
        `## Description\n${runbook.description}\n\n` +
        `## Steps\n${runbook.steps}`
      );
    } catch (err) {
      return errorResult("Failed to get runbook", err);
    }
  }
);

// ---- get_permission_profile ----
server.tool(
  "get_permission_profile",
  "Analyze tool usage for a project to generate a permission profile. " +
    "Shows which tools are used, error rates, durations, and example inputs. " +
    "Useful for configuring Claude Code permissions based on observed patterns.",
  {
    project: z.string().describe("Project directory name or display name"),
  },
  async (params) => {
    try {
      const project = db.resolveProject(params.project);
      if (!project) return notFound("project", params.project);

      const profile = db.getPermissionProfile(project.dirName);
      if (profile.length === 0) return emptyResult("tool usage data", DEEP_HINT);

      const sections = [`# Permission Profile: ${project.name}\n`];

      // Group by risk level
      const safe = profile.filter((t) => t.errorRate < 0.05);
      const moderate = profile.filter((t) => t.errorRate >= 0.05 && t.errorRate < 0.2);
      const risky = profile.filter((t) => t.errorRate >= 0.2);

      if (safe.length > 0) {
        sections.push("## Safe to Auto-Allow (< 5% error rate)");
        for (const t of safe) {
          const dur = t.avgDurationMs !== null ? ` ~${Math.round(t.avgDurationMs)}ms` : "";
          sections.push(`- ${t.toolName}: ${t.totalUses} uses${dur}`);
        }
      }

      if (moderate.length > 0) {
        sections.push("\n## Review Recommended (5-20% error rate)");
        for (const t of moderate) {
          sections.push(`- ${t.toolName}: ${t.totalUses} uses, ${(t.errorRate * 100).toFixed(1)}% errors`);
        }
      }

      if (risky.length > 0) {
        sections.push("\n## Caution Required (> 20% error rate)");
        for (const t of risky) {
          sections.push(`- ${t.toolName}: ${t.totalUses} uses, ${(t.errorRate * 100).toFixed(1)}% errors`);
          for (const ex of t.exampleInputs) {
            sections.push(`    Example: ${ex.slice(0, 150)}`);
          }
        }
      }

      return textResult(sections.join("\n"));
    } catch (err) {
      return errorResult("Failed to get permission profile", err);
    }
  }
);

// ---- get_memory_health ----
server.tool(
  "get_memory_health",
  "Health check on stored learnings: duplicates, stale data, and distribution. " +
    "Useful for identifying memory that needs cleanup or refresh.",
  {},
  async () => {
    try {
      const health = db.getMemoryHealth();
      const duplicates = db.getDuplicateLearnings();
      const stale = db.getStaleLearnings();

      const sections = ["# Memory Health Report\n"];

      sections.push(`Total learnings: ${health.totalLearnings}`);
      sections.push(`Duplicate groups: ${health.duplicateCount}`);
      sections.push(`Stale projects (>7 days): ${health.staleProjectCount}`);

      if (health.categoryDistribution.length > 0) {
        sections.push("\n## Category Distribution");
        for (const c of health.categoryDistribution) {
          sections.push(`- ${c.category}: ${c.count}`);
        }
      }

      if (health.learningsPerProject.length > 0) {
        sections.push("\n## Learnings per Project");
        for (const p of health.learningsPerProject) {
          sections.push(`- ${p.projectName}: ${p.count}`);
        }
      }

      if (duplicates.length > 0) {
        sections.push("\n## Duplicate Learnings");
        for (const d of duplicates.slice(0, 10)) {
          sections.push(`- ${d.projectName}: "${d.fingerprint}..." (${d.count}x, IDs: ${d.ids})`);
        }
      }

      if (stale.length > 0) {
        sections.push("\n## Stale Projects");
        for (const s of stale) {
          sections.push(`- ${s.projectName}: ${s.learningCount} learnings, last scanned ${s.daysSinceScanned} days ago`);
        }
      }

      return textResult(sections.join("\n"));
    } catch (err) {
      return errorResult("Failed to get memory health", err);
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
