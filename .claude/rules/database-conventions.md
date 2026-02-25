---
description: SQLite database patterns for the monitor storage layer
globs: src/storage/**
---

# Database Conventions

## Single File for All SQL

All SQL statements, schema definitions, and query methods MUST live in
`src/storage/database.ts`. No other file MAY contain raw SQL strings.

## Schema Versioning

Schema version MUST be tracked in a `meta` table (`key TEXT PRIMARY KEY, value TEXT`).
Migrations are sequential methods `_migrateVN()` called from the constructor.
MUST bump version and add migration when changing schema.

## WAL Mode and Pragmas

MUST enable WAL mode and set `journal_mode=WAL`, `busy_timeout=5000`,
`foreign_keys=ON` at connection time.

## FTS5 Index Sync

FTS5 content tables MUST use triggers to stay in sync with the base tables.
SHOULD test FTS sync in isolation (insert row, verify FTS match, delete row, verify
FTS no longer matches).

## Prepared Statements

MUST use parameterized queries for all user-facing data. MUST NOT interpolate
search terms or project names into SQL strings.
