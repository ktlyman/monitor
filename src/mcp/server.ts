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
 */

// TODO: Implement MCP server using @modelcontextprotocol/sdk
// Example registration pattern from controller-ring:
//
// import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
//
// const server = new McpServer({ name: "monitor", version: "0.1.0" });
//
// server.tool("search_learnings", { query: z.string(), ... }, async (params) => {
//   // ... query MonitorDatabase
// });
//
// const transport = new StdioServerTransport();
// await server.connect(transport);

console.error("Monitor MCP server starting...");
console.error("TODO: Implement MCP tool registration");
