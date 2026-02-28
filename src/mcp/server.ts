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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MonitorDatabase } from "../storage/database.js";
import { generateRecommendations } from "../analyzer/recommendations.js";

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
      sections.push(`Path: ${project.projectPath.replace(/^\/Users\/[^/]+/, "~")}`);
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
