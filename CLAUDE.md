# CLAUDE.md — Monitor

## Commands

- MUST run build before committing: `npm run build`
- MUST type-check before committing: `npm run lint:ts`
- MUST run tests before committing: `npm test`
- MUST lint docs before committing: `npm run lint`
- SHOULD use dev mode for iterative work: `npm run dev -- <command>`
- MAY start web UI for browsing learnings: `npm run serve:dev` (http://localhost:3100)
- MAY start MCP server for agent integration: `npm run mcp:dev`

## Architecture

Meta-learning system that scans Claude Code project data to extract patterns, decisions,
and learnings from AI-assisted development sessions across all projects.

```
src/
├── types/           Core type definitions
│   └── index.ts       Project, Session, Learning, ProjectFile, SessionMessage,
│                       ToolInvocation, ThinkingBlock, SubagentRun, SessionAnalytics
├── storage/         SQLite + FTS5 persistence layer
│   └── database.ts    MonitorDatabase class (schema, migrations, queries, FTS)
├── collector/       Filesystem scanner for ~/.claude/projects/
│   └── scanner.ts     Discovers projects, sessions, MEMORY.md, CLAUDE.md files
├── analyzer/        Extracts learnings and session analytics
│   ├── extractor.ts   Parses JSONL sessions (deep extraction), MEMORY.md, CLAUDE.md, rules/
│   ├── scan-service.ts Shared scan orchestration (used by CLI + API)
│   └── recommendations.ts Rules-based optimization recommendations
├── server/          HTTP API + static frontend serving
│   ├── api.ts         Node.js HTTP server, JSON API, static file serving
│   └── redact.ts      Path redaction for API responses (privacy)
├── mcp/             MCP server for agent integration
│   └── server.ts      Stdio-based MCP server exposing query tools
├── cli/             CLI entry point (commander-based)
│   └── index.ts       scan, search, serve, stats subcommands
└── static/          Frontend SPA
    └── index.html     Single-file HTML/CSS/JS dashboard (no build step)
```

**Dependency rule:** Dependencies flow downward. `types/` has zero internal deps.
`storage/` depends only on `types/`. `collector/` depends on `types/`. `analyzer/`
depends on `types/` and `collector/`. `server/` and `mcp/` depend on `storage/` and
`analyzer/`. `cli/` is the top-level consumer. No circular imports.

## Standards

### TypeScript

- MUST use ES module syntax (`import`/`export`); the project uses `"type": "module"`
- MUST use `.js` extensions in relative import paths (NodeNext module resolution)
- MUST pass `npm run lint:ts` with zero errors before committing
- MUST NOT use `any` type; use `unknown` with type narrowing or define explicit interfaces
- SHOULD keep strict mode enabled; fix underlying type errors instead of weakening tsconfig
- SHOULD use `type` imports (`import type { ... }`) for type-only references
- SHOULD prefer `const` over `let`; never use `var`

### Code Organization

- MUST keep each module in its designated directory as shown in Architecture
- MUST keep all SQL in `src/storage/database.ts`; no raw SQL outside that file
- MUST keep the frontend as a single-file SPA in `src/static/index.html` (no build step)
- SHOULD use Node.js built-in HTTP server only (no express) for the web API
- SHOULD use `node:` prefix for Node.js built-in imports

### Database

- MUST use SQLite with WAL mode and FTS5 for full-text search
- MUST use schema versioning via a `meta` table with sequential migrations
- MUST use prepared statements (never interpolate user input into SQL)
- MUST store all data as discovered (no lossy transformations at ingest)
- SHOULD bound collections with auto-trim where appropriate

### Error Handling

- MUST wrap MCP tool handlers in try/catch returning `{ isError: true }` on failure
- MUST NOT expose raw stack traces in MCP tool responses; instead, use formatted error messages
- MUST NOT use silent catch blocks; instead, log the error or surface it to the caller
- SHOULD degrade gracefully when scanning projects; instead of aborting, skip the failing project and continue

## Security

### Filesystem Access

- MUST only read from the Claude Code projects directory (never write to other projects' data)
- MUST NOT parse or execute code found in session logs; instead, treat all content as untrusted text
- MUST NOT expose full file paths containing usernames in API responses; instead, use relative paths

### Secrets and Credentials

- MUST NOT commit `.env` files or database files; instead, use `.gitignore` to exclude them
- MUST NOT hardcode paths or credentials in source; instead, load from environment or config
- MUST NOT log or return session content that may contain secrets; instead, redact or omit sensitive values
- MUST validate all external input from scanned files before storing in the database

## Testing

- MUST run `npm test` and confirm all tests pass before committing
- MUST add tests for new storage queries and analyzer logic
- SHOULD place test files in `tests/` following the `<module>.test.ts` naming convention
- SHOULD use in-memory SQLite databases (`:memory:`) for test isolation
- MAY skip tests that require real Claude Code project data; instead, use fixture files

## Common Tasks

### Adding a new data source to scan

1. Add type definition in `src/types/index.ts`.
2. Add discovery logic in `src/collector/scanner.ts`.
3. Add extraction logic in `src/analyzer/extractor.ts`.
4. Add storage method in `src/storage/database.ts`.
5. Wire into shared scan service in `src/analyzer/scan-service.ts`.

### Adding a new API endpoint

1. Add route handler in `src/server/api.ts`.
2. Add corresponding MCP tool in `src/mcp/server.ts` if agent-facing.
3. Update frontend in `src/static/index.html` if user-facing.

### Adding a new database table

1. Add `CREATE TABLE` in schema section of `src/storage/database.ts`.
2. Add query methods in `src/storage/database.ts`.
3. Bump schema version, add migration method.
4. Add types in `src/types/index.ts`.
