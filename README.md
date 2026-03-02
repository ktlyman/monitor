# Monitor

A meta-learning system for Claude Code projects. Scans `~/.claude/projects/` to extract
patterns, decisions, and learnings from AI-assisted development sessions, stores them
in a searchable SQLite database, and serves them through a web UI and MCP server.

## What It Does

- **Session scanning** -- Discovers and parses JSONL session logs from all Claude Code projects
- **Deep extraction** -- Extracts per-message token usage, tool invocations, thinking blocks,
  subagent runs, and session analytics with streaming fragment dedup and per-model cost estimates
  (Opus 4.6, Sonnet 4.6, Sonnet 4, Haiku 4.5). Incremental: skips sessions whose file size
  hasn't changed since last extraction
- **Knowledge extraction** -- Extracts learnings from MEMORY.md files, CLAUDE.md conventions,
  .claude/rules/ (recursive), and agent-lessons files
- **Full-text search** -- SQLite FTS5-powered search across all collected learnings and thinking blocks
- **Write-back & guidance** -- Agents can persist notes (observations, decisions, outcomes, todos)
  and runbooks (reusable step sequences) back into Monitor. Task briefs aggregate learnings,
  anti-patterns, and runbooks into contextual starting points for new work
- **Web dashboard** -- Single-page app with Analytics tab (token counts, cost estimates, tool
  reliability, model breakdown, cost trends, tool sequences, anti-patterns, plans, memory health,
  notes, runbooks, recommendations), project browser, learning search, and thinking block search
- **MCP server** -- 30 tools, 2 resources, 2 prompts for query, write-back, and active guidance
  via the Model Context Protocol
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

Build first with `npm run build`, then add to your Claude Code MCP config
(`~/.claude/claude_desktop_config.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "monitor": {
      "command": "node",
      "args": ["/absolute/path/to/monitor/build/mcp/server.js"],
      "env": {
        "DB_PATH": "/absolute/path/to/monitor/monitor.db"
      }
    }
  }
}
```

`DB_PATH` defaults to `monitor.db` in the working directory. Use an absolute path
to ensure the MCP server finds your database regardless of where it's launched from.

The MCP server exposes 30 tools, 2 resources, and 2 prompts:

**Query tools:**
- `search_learnings` — Full-text search across learnings (memory, claude_md, rules, agent_lessons)
- `list_projects` — List all discovered projects with directory names and session counts
- `get_project_summary` — Learnings, files, and sessions for a project (accepts dir_name or name)
- `get_stats` — Database-wide statistics
- `search_thinking` — Full-text search across thinking blocks
- `search_messages` — Full-text search across session message content
- `list_project_files` — List documentation files for a project
- `get_file_content` — Retrieve the full content of a project documentation file
- `get_session_analytics` — Full analytics for a specific session
- `get_session_messages` — Browse message metadata for a session
- `get_session_requests` — Per-request cost breakdown for a session
- `get_model_breakdown` — Per-model token and message statistics

**Analytics tools:**
- `get_tool_success_rates` — Per-tool reliability with duration and I/O sizes
- `get_expensive_sessions` — Most expensive sessions ranked by estimated cost
- `get_expensive_requests` — Most expensive individual API requests
- `get_recommendations` — Rules-based optimization suggestions
- `get_plans` — Implementation plans from ExitPlanMode invocations
- `get_cross_project_patterns` — Conventions shared across 3+ projects
- `get_cost_trends` — Daily cost time series by project
- `get_tool_sequences` — Common consecutive tool call pairs
- `get_anti_patterns` — Sessions with high error rates or unusual cost
- `get_convention_drift` — Files that have changed over time (version tracking)
- `get_permission_profile` — Per-tool error analysis (safe/moderate/risky)
- `get_memory_health` — Duplicate detection and stale learning analysis

**Write-back tools:**
- `start_task` — Get a contextual task brief (learnings, anti-patterns, runbooks)
- `add_note` — Persist an observation, decision, outcome, or todo
- `get_notes` — Retrieve notes for a project or session
- `create_runbook` — Create a reusable step sequence
- `list_runbooks` — List runbooks (project-scoped or cross-project)
- `get_runbook` — Retrieve a specific runbook by ID

**Resources:** `monitor://projects/{project}/claude-md`, `monitor://projects/{project}/memory`

**Prompts:** `project-brief` (aggregated context for starting work), `session-review` (retrospective analysis)

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
