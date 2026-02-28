# Monitor

A meta-learning system for Claude Code projects. Scans `~/.claude/projects/` to extract
patterns, decisions, and learnings from AI-assisted development sessions, stores them
in a searchable SQLite database, and serves them through a web UI and MCP server.

## What It Does

- **Session scanning** -- Discovers and parses JSONL session logs from all Claude Code projects
- **Deep extraction** -- Extracts per-message token usage, tool invocations, thinking blocks,
  subagent runs, and session analytics with streaming fragment dedup and Opus 4.6 cost estimates
- **Knowledge extraction** -- Extracts learnings from MEMORY.md files, CLAUDE.md conventions,
  .claude/rules/, agent-lessons files, and session transcripts
- **Full-text search** -- SQLite FTS5-powered search across all collected learnings and thinking blocks
- **Web dashboard** -- Single-page app with Analytics tab (API requests, token counts, cost estimates,
  top tools), project browser, learning search, and thinking block search
- **MCP server** -- Exposes meta-learnings to Claude Code agents via the Model Context Protocol,
  enabling "learning to learn" across projects
- **CLI** -- Scan projects, search learnings, and inspect patterns from the terminal

## Quick Start

```bash
# Install dependencies
npm install

# Scan all Claude Code projects
npm run dev -- scan

# Search across collected learnings
npm run dev -- search "database migration"

# Start the web UI
npm run serve:dev
# Open http://localhost:3100

# Show stats
npm run dev -- stats
```

## CLI Usage

```bash
# Full scan of ~/.claude/projects/
npm run dev -- scan

# Deep scan (extract messages, tools, thinking, analytics)
npm run dev -- scan --deep

# Force re-extraction of all sessions
npm run dev -- scan --deep --force

# Scan a specific project
npm run dev -- scan --project listener

# Search learnings
npm run dev -- search "error handling"

# List discovered projects
npm run dev -- projects

# Show database stats
npm run dev -- stats
```

## MCP Server

Add to your Claude Code or Claude Desktop config:

```json
{
  "mcpServers": {
    "monitor": {
      "command": "node",
      "args": ["build/mcp/server.js"],
      "cwd": "/Users/kevin/Projects/monitor"
    }
  }
}
```

Build first with `npm run build`, then the MCP server exposes tools for querying
meta-learnings across all your Claude Code projects.

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Run CLI in dev mode (via tsx)
npm run serve:dev    # Start web server in dev mode
npm run mcp:dev      # Start MCP server in dev mode
npm run lint:ts      # Type check
npm run lint         # Lint CLAUDE.md
npm test             # Run tests
```

Requires Node.js >= 20.

## Architecture

See [CLAUDE.md](CLAUDE.md) for the full architecture diagram, dependency rules,
code conventions, and common task playbooks.

## Tech Stack

- **TypeScript** with strict mode, ES2022 target, ESM
- **SQLite** via better-sqlite3 with FTS5 full-text search
- **Commander.js** for CLI
- **MCP protocol** over stdio for AI agent integration
- **Node.js HTTP** server (no framework) for the web API
- **Vanilla HTML/CSS/JS** single-page frontend (no build step)
