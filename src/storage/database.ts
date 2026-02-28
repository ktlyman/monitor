import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Learning,
  Project,
  ProjectFile,
  FileVersion,
  Session,
  SessionMessage,
  ToolInvocation,
  ThinkingBlock,
  SubagentRun,
  ToolResultFile,
  SessionAnalytics,
  SearchOptions,
  SearchResult,
  SystemStats,
} from "../types/index.js";

const SCHEMA_VERSION = 6;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    dir_name        TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    project_path    TEXT NOT NULL,
    session_count   INTEGER NOT NULL DEFAULT 0,
    has_memory      INTEGER NOT NULL DEFAULT 0,
    has_claude_md   INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id             TEXT PRIMARY KEY,
    project_dir_name       TEXT NOT NULL REFERENCES projects(dir_name),
    jsonl_path             TEXT NOT NULL,
    started_at             TEXT,
    ended_at               TEXT,
    user_message_count     INTEGER NOT NULL DEFAULT 0,
    assistant_message_count INTEGER NOT NULL DEFAULT 0,
    tool_use_count         INTEGER NOT NULL DEFAULT 0,
    file_size_bytes        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir_name);

  CREATE TABLE IF NOT EXISTS learnings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name  TEXT NOT NULL,
    source_type   TEXT NOT NULL,
    source_path   TEXT NOT NULL,
    content       TEXT NOT NULL,
    category      TEXT NOT NULL,
    extracted_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_name);
  CREATE INDEX IF NOT EXISTS idx_learnings_source ON learnings(source_type);
  CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);

  CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
    content,
    project_name,
    source_type,
    category,
    content='learnings',
    content_rowid='id',
    tokenize='porter'
  );

  CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, content, project_name, source_type, category)
    VALUES (new.id, new.content, new.project_name, new.source_type, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, content, project_name, source_type, category)
    VALUES ('delete', old.id, old.content, old.project_name, old.source_type, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, content, project_name, source_type, category)
    VALUES ('delete', old.id, old.content, old.project_name, old.source_type, old.category);
    INSERT INTO learnings_fts(rowid, content, project_name, source_type, category)
    VALUES (new.id, new.content, new.project_name, new.source_type, new.category);
  END;
`;

const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS project_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name  TEXT NOT NULL,
    file_type     TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    content       TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    UNIQUE(project_name, relative_path)
  );

  CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_name);
  CREATE INDEX IF NOT EXISTS idx_project_files_type ON project_files(file_type);

  CREATE TABLE IF NOT EXISTS project_file_versions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_file_id  INTEGER NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
    content          TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL DEFAULT 0,
    recorded_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_file_versions_file ON project_file_versions(project_file_id);
`;

const SCHEMA_V3 = `
  CREATE TABLE IF NOT EXISTS session_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    uuid            TEXT NOT NULL,
    parent_uuid     TEXT,
    entry_type      TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    model           TEXT,
    stop_reason     TEXT,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    content_block_count INTEGER NOT NULL DEFAULT 0,
    cwd             TEXT,
    git_branch      TEXT,
    UNIQUE(session_id, uuid)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_type ON session_messages(entry_type);
  CREATE INDEX IF NOT EXISTS idx_messages_model ON session_messages(model);

  CREATE TABLE IF NOT EXISTS tool_invocations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    message_uuid    TEXT NOT NULL,
    tool_use_id     TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    input_summary   TEXT NOT NULL DEFAULT '',
    is_error        INTEGER NOT NULL DEFAULT 0,
    timestamp       TEXT NOT NULL,
    UNIQUE(session_id, tool_use_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_invocations(session_id);
  CREATE INDEX IF NOT EXISTS idx_tools_name ON tool_invocations(tool_name);

  CREATE TABLE IF NOT EXISTS thinking_blocks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    message_uuid    TEXT NOT NULL,
    content         TEXT NOT NULL,
    content_length  INTEGER NOT NULL DEFAULT 0,
    timestamp       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_thinking_session ON thinking_blocks(session_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS thinking_fts USING fts5(
    content,
    session_id,
    content='thinking_blocks',
    content_rowid='id',
    tokenize='porter'
  );

  CREATE TRIGGER IF NOT EXISTS thinking_ai AFTER INSERT ON thinking_blocks BEGIN
    INSERT INTO thinking_fts(rowid, content, session_id)
    VALUES (new.id, new.content, new.session_id);
  END;

  CREATE TRIGGER IF NOT EXISTS thinking_ad AFTER DELETE ON thinking_blocks BEGIN
    INSERT INTO thinking_fts(thinking_fts, rowid, content, session_id)
    VALUES ('delete', old.id, old.content, old.session_id);
  END;

  CREATE TABLE IF NOT EXISTS subagent_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id   TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    jsonl_path          TEXT NOT NULL,
    prompt              TEXT NOT NULL DEFAULT '',
    message_count       INTEGER NOT NULL DEFAULT 0,
    tool_use_count      INTEGER NOT NULL DEFAULT 0,
    total_input_tokens  INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    started_at          TEXT,
    ended_at            TEXT,
    file_size_bytes     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(parent_session_id, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagent_runs(parent_session_id);

  CREATE TABLE IF NOT EXISTS tool_result_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    tool_use_id     TEXT NOT NULL,
    content         TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, tool_use_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_result_files(session_id);

  CREATE TABLE IF NOT EXISTS session_analytics (
    session_id              TEXT PRIMARY KEY,
    total_input_tokens      INTEGER NOT NULL DEFAULT 0,
    total_output_tokens     INTEGER NOT NULL DEFAULT 0,
    total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd      REAL NOT NULL DEFAULT 0.0,
    tool_breakdown          TEXT NOT NULL DEFAULT '{}',
    error_count             INTEGER NOT NULL DEFAULT 0,
    total_tool_uses         INTEGER NOT NULL DEFAULT 0,
    thinking_block_count    INTEGER NOT NULL DEFAULT 0,
    thinking_char_count     INTEGER NOT NULL DEFAULT 0,
    subagent_count          INTEGER NOT NULL DEFAULT 0,
    models                  TEXT NOT NULL DEFAULT '',
    duration_seconds        REAL NOT NULL DEFAULT 0.0,
    deep_extracted_at       TEXT NOT NULL
  );
`;

/**
 * SQLite persistence layer for the Monitor system.
 * All SQL lives in this file. Uses FTS5 for full-text search.
 */
export class MonitorDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this._initSchema();
  }

  private _initSchema(): void {
    this.db.exec(SCHEMA);

    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    const currentVersion = row ? parseInt(row.value, 10) : 0;

    if (currentVersion < SCHEMA_VERSION) {
      if (currentVersion < 2) this._migrateV2();
      if (currentVersion < 3) this._migrateV3();
      if (currentVersion < 4) this._migrateV4();
      if (currentVersion < 5) this._migrateV5();
      if (currentVersion < 6) this._migrateV6();
      this.db
        .prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
        )
        .run(String(SCHEMA_VERSION));
    }
  }

  // ---- Project methods ----

  upsertProject(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (dir_name, name, project_path, session_count, has_memory, has_claude_md, last_scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dir_name) DO UPDATE SET
           name = excluded.name,
           project_path = excluded.project_path,
           session_count = excluded.session_count,
           has_memory = excluded.has_memory,
           has_claude_md = excluded.has_claude_md,
           last_scanned_at = excluded.last_scanned_at`
      )
      .run(
        project.dirName,
        project.name,
        project.projectPath,
        project.sessionCount,
        project.hasMemory ? 1 : 0,
        project.hasClaudeMd ? 1 : 0,
        project.lastScannedAt
      );
  }

  getProjects(): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY name")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      dirName: r.dir_name as string,
      name: r.name as string,
      projectPath: r.project_path as string,
      sessionCount: r.session_count as number,
      hasMemory: (r.has_memory as number) === 1,
      hasClaudeMd: (r.has_claude_md as number) === 1,
      lastScannedAt: r.last_scanned_at as string,
    }));
  }

  // ---- Session methods ----

  upsertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, project_dir_name, jsonl_path, started_at, ended_at,
           user_message_count, assistant_message_count, tool_use_count, file_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           user_message_count = excluded.user_message_count,
           assistant_message_count = excluded.assistant_message_count,
           tool_use_count = excluded.tool_use_count,
           file_size_bytes = excluded.file_size_bytes`
      )
      .run(
        session.sessionId,
        session.projectDirName,
        session.jsonlPath,
        session.startedAt,
        session.endedAt,
        session.userMessageCount,
        session.assistantMessageCount,
        session.toolUseCount,
        session.fileSizeBytes
      );
  }

  /** Get all sessions for a project, enriched with analytics if available. */
  getSessions(projectDirName: string): Array<Session & { analytics?: SessionAnalytics }> {
    const rows = this.db
      .prepare(
        `SELECT s.*, sa.total_input_tokens, sa.total_output_tokens,
                sa.total_cache_creation_tokens, sa.total_cache_read_tokens,
                sa.total_cache_write_5m_tokens, sa.total_cache_write_1h_tokens,
                sa.estimated_cost_usd, sa.tool_breakdown, sa.error_count,
                sa.total_tool_uses, sa.thinking_block_count, sa.thinking_char_count,
                sa.subagent_count, sa.api_request_count, sa.models,
                sa.duration_seconds, sa.deep_extracted_at
         FROM sessions s
         LEFT JOIN session_analytics sa ON sa.session_id = s.session_id
         WHERE s.project_dir_name = ?
         ORDER BY s.started_at DESC`
      )
      .all(projectDirName) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const session: Session = {
        sessionId: r.session_id as string,
        projectDirName: r.project_dir_name as string,
        jsonlPath: r.jsonl_path as string,
        startedAt: r.started_at as string,
        endedAt: r.ended_at as string,
        userMessageCount: r.user_message_count as number,
        assistantMessageCount: r.assistant_message_count as number,
        toolUseCount: r.tool_use_count as number,
        fileSizeBytes: r.file_size_bytes as number,
      };

      if (r.deep_extracted_at) {
        return {
          ...session,
          analytics: {
            sessionId: r.session_id as string,
            totalInputTokens: r.total_input_tokens as number,
            totalOutputTokens: r.total_output_tokens as number,
            totalCacheCreationTokens: r.total_cache_creation_tokens as number,
            totalCacheReadTokens: r.total_cache_read_tokens as number,
            totalCacheWrite5mTokens: (r.total_cache_write_5m_tokens as number) ?? 0,
            totalCacheWrite1hTokens: (r.total_cache_write_1h_tokens as number) ?? 0,
            estimatedCostUsd: r.estimated_cost_usd as number,
            toolBreakdown: JSON.parse(r.tool_breakdown as string) as Record<string, number>,
            errorCount: r.error_count as number,
            totalToolUses: r.total_tool_uses as number,
            thinkingBlockCount: r.thinking_block_count as number,
            thinkingCharCount: r.thinking_char_count as number,
            subagentCount: r.subagent_count as number,
            apiRequestCount: (r.api_request_count as number) ?? 0,
            models: r.models as string,
            durationSeconds: r.duration_seconds as number,
            deepExtractedAt: r.deep_extracted_at as string,
          },
        };
      }

      return session;
    });
  }

  // ---- Learning methods ----

  insertLearning(learning: Learning): number {
    const result = this.db
      .prepare(
        `INSERT INTO learnings (project_name, project_dir_name, source_type, source_path, content, category, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        learning.projectName,
        learning.projectDirName,
        learning.sourceType,
        learning.sourcePath,
        learning.content,
        learning.category,
        learning.extractedAt
      );
    return Number(result.lastInsertRowid);
  }

  clearLearningsForProject(projectDirName: string): void {
    this.db
      .prepare("DELETE FROM learnings WHERE project_dir_name = ?")
      .run(projectDirName);
  }

  // ---- Search methods ----

  search(options: SearchOptions): SearchResult[] {
    const params: unknown[] = [options.query];
    let whereClause = "";
    const filters: string[] = [];

    if (options.projectNames?.length) {
      filters.push(
        `l.project_name IN (${options.projectNames.map(() => "?").join(",")})`
      );
      params.push(...options.projectNames);
    }
    if (options.sourceTypes?.length) {
      filters.push(
        `l.source_type IN (${options.sourceTypes.map(() => "?").join(",")})`
      );
      params.push(...options.sourceTypes);
    }
    if (options.categories?.length) {
      filters.push(
        `l.category IN (${options.categories.map(() => "?").join(",")})`
      );
      params.push(...options.categories);
    }

    if (filters.length > 0) {
      whereClause = "AND " + filters.join(" AND ");
    }

    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    params.push(limit, offset);

    const rows = this.db
      .prepare(
        `SELECT l.*, snippet(learnings_fts, 0, '<b>', '</b>', '...', 40) AS snippet,
                rank
         FROM learnings_fts
         JOIN learnings l ON l.id = learnings_fts.rowid
         WHERE learnings_fts MATCH ?
         ${whereClause}
         ORDER BY rank
         LIMIT ? OFFSET ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      learning: {
        id: r.id as number,
        projectName: r.project_name as string,
        projectDirName: (r.project_dir_name as string) ?? "",
        sourceType: r.source_type as string,
        sourcePath: r.source_path as string,
        content: r.content as string,
        category: r.category as string,
        extractedAt: r.extracted_at as string,
      } as Learning,
      snippet: r.snippet as string,
      rank: r.rank as number,
    }));
  }

  // ---- Stats ----

  getStats(): SystemStats {
    const totalProjects = (
      this.db.prepare("SELECT COUNT(*) as c FROM projects").get() as {
        c: number;
      }
    ).c;
    const totalSessions = (
      this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as {
        c: number;
      }
    ).c;
    const totalLearnings = (
      this.db.prepare("SELECT COUNT(*) as c FROM learnings").get() as {
        c: number;
      }
    ).c;

    const bySource = this.db
      .prepare(
        "SELECT source_type, COUNT(*) as c FROM learnings GROUP BY source_type"
      )
      .all() as Array<{ source_type: string; c: number }>;
    const byCategory = this.db
      .prepare(
        "SELECT category, COUNT(*) as c FROM learnings GROUP BY category"
      )
      .all() as Array<{ category: string; c: number }>;

    const projectRows = this.db
      .prepare(
        `SELECT p.name, p.session_count as sessions,
                (SELECT COUNT(*) FROM learnings l WHERE l.project_dir_name = p.dir_name) as learnings,
                p.last_scanned_at as lastScanned
         FROM projects p ORDER BY p.name`
      )
      .all() as Array<{
      name: string;
      sessions: number;
      learnings: number;
      lastScanned: string;
    }>;

    return {
      totalProjects,
      totalSessions,
      totalLearnings,
      learningsBySource: Object.fromEntries(
        bySource.map((r) => [r.source_type, r.c])
      ),
      learningsByCategory: Object.fromEntries(
        byCategory.map((r) => [r.category, r.c])
      ),
      projects: projectRows,
      analytics: this.getAnalyticsStats(),
    };
  }

  // ---- Project file methods ----

  /** Upsert a project file. Only creates a new version if content changed. */
  upsertProjectFile(file: Omit<ProjectFile, "id" | "firstSeenAt" | "lastSeenAt" | "contentHash" | "sizeBytes">): { changed: boolean } {
    const hash = createHash("sha256").update(file.content).digest("hex");
    const sizeBytes = Buffer.byteLength(file.content, "utf-8");
    const now = new Date().toISOString();

    const existing = this.db
      .prepare("SELECT id, content_hash FROM project_files WHERE project_dir_name = ? AND relative_path = ?")
      .get(file.projectDirName, file.relativePath) as { id: number; content_hash: string } | undefined;

    if (existing) {
      if (existing.content_hash === hash) {
        // Content unchanged — just update last_seen_at
        this.db
          .prepare("UPDATE project_files SET last_seen_at = ? WHERE id = ?")
          .run(now, existing.id);
        return { changed: false };
      }

      // Content changed — update current and archive old version
      this.db
        .prepare(
          `UPDATE project_files SET content = ?, content_hash = ?, size_bytes = ?, last_seen_at = ?
           WHERE id = ?`
        )
        .run(file.content, hash, sizeBytes, now, existing.id);

      // Archive the previous version (the one being replaced is already saved as a version from its first insert)
      this.db
        .prepare(
          `INSERT INTO project_file_versions (project_file_id, content, content_hash, size_bytes, recorded_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(existing.id, file.content, hash, sizeBytes, now);

      return { changed: true };
    }

    // New file — insert and create first version
    const result = this.db
      .prepare(
        `INSERT INTO project_files (project_name, project_dir_name, file_type, relative_path, content, content_hash, size_bytes, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(file.projectName, file.projectDirName, file.fileType, file.relativePath, file.content, hash, sizeBytes, now, now);

    const fileId = Number(result.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO project_file_versions (project_file_id, content, content_hash, size_bytes, recorded_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(fileId, file.content, hash, sizeBytes, now);

    return { changed: true };
  }

  /** Get all files for a project by dirName. */
  getProjectFiles(projectDirName: string): ProjectFile[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_name, project_dir_name, file_type, relative_path, content, content_hash, size_bytes, first_seen_at, last_seen_at
         FROM project_files WHERE project_dir_name = ? ORDER BY file_type, relative_path`
      )
      .all(projectDirName) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      projectName: r.project_name as string,
      projectDirName: r.project_dir_name as string,
      fileType: r.file_type as string,
      relativePath: r.relative_path as string,
      content: r.content as string,
      contentHash: r.content_hash as string,
      sizeBytes: r.size_bytes as number,
      firstSeenAt: r.first_seen_at as string,
      lastSeenAt: r.last_seen_at as string,
    })) as ProjectFile[];
  }

  /** Get a single file by project dirName and path. */
  getProjectFile(projectDirName: string, relativePath: string): ProjectFile | null {
    const r = this.db
      .prepare(
        `SELECT id, project_name, project_dir_name, file_type, relative_path, content, content_hash, size_bytes, first_seen_at, last_seen_at
         FROM project_files WHERE project_dir_name = ? AND relative_path = ?`
      )
      .get(projectDirName, relativePath) as Record<string, unknown> | undefined;

    if (!r) return null;
    return {
      id: r.id as number,
      projectName: r.project_name as string,
      projectDirName: r.project_dir_name as string,
      fileType: r.file_type as string,
      relativePath: r.relative_path as string,
      content: r.content as string,
      contentHash: r.content_hash as string,
      sizeBytes: r.size_bytes as number,
      firstSeenAt: r.first_seen_at as string,
      lastSeenAt: r.last_seen_at as string,
    } as ProjectFile;
  }

  /** Get version history for a file. */
  getFileVersions(projectFileId: number): FileVersion[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_file_id, content, content_hash, size_bytes, recorded_at
         FROM project_file_versions WHERE project_file_id = ? ORDER BY recorded_at DESC`
      )
      .all(projectFileId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      projectFileId: r.project_file_id as number,
      content: r.content as string,
      contentHash: r.content_hash as string,
      sizeBytes: r.size_bytes as number,
      recordedAt: r.recorded_at as string,
    }));
  }

  /** Get file counts per project. */
  getFileStats(): Array<{ projectName: string; fileCount: number; totalBytes: number }> {
    return this.db
      .prepare(
        `SELECT project_name, COUNT(*) as file_count, SUM(size_bytes) as total_bytes
         FROM project_files GROUP BY project_name ORDER BY project_name`
      )
      .all() as Array<{ projectName: string; fileCount: number; totalBytes: number }>;
  }

  // ---- Session analytics methods ----

  /** Batch insert session messages in a transaction. */
  insertSessionMessages(messages: SessionMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_messages
       (session_id, uuid, parent_uuid, entry_type, timestamp, model, stop_reason,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        content_block_count, cwd, git_branch, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const m of messages) {
        stmt.run(
          m.sessionId, m.uuid, m.parentUuid, m.entryType, m.timestamp,
          m.model, m.stopReason, m.inputTokens, m.outputTokens,
          m.cacheCreationTokens, m.cacheReadTokens, m.contentBlockCount,
          m.cwd, m.gitBranch, m.content ?? null
        );
      }
    });
    tx();
  }

  /** Batch insert tool invocations in a transaction. */
  insertToolInvocations(invocations: ToolInvocation[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO tool_invocations
       (session_id, message_uuid, tool_use_id, tool_name, input_summary, is_error, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const t of invocations) {
        stmt.run(
          t.sessionId, t.messageUuid, t.toolUseId, t.toolName,
          t.inputSummary, t.isError ? 1 : 0, t.timestamp
        );
      }
    });
    tx();
  }

  /** Batch insert thinking blocks in a transaction. */
  insertThinkingBlocks(blocks: ThinkingBlock[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO thinking_blocks
       (session_id, message_uuid, content, content_length, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const b of blocks) {
        stmt.run(b.sessionId, b.messageUuid, b.content, b.contentLength, b.timestamp);
      }
    });
    tx();
  }

  /** Upsert a subagent run. */
  upsertSubagentRun(run: SubagentRun): void {
    this.db
      .prepare(
        `INSERT INTO subagent_runs
         (parent_session_id, agent_id, jsonl_path, prompt, message_count, tool_use_count,
          total_input_tokens, total_output_tokens, started_at, ended_at, file_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
           jsonl_path = excluded.jsonl_path,
           prompt = excluded.prompt,
           message_count = excluded.message_count,
           tool_use_count = excluded.tool_use_count,
           total_input_tokens = excluded.total_input_tokens,
           total_output_tokens = excluded.total_output_tokens,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           file_size_bytes = excluded.file_size_bytes`
      )
      .run(
        run.parentSessionId, run.agentId, run.jsonlPath, run.prompt,
        run.messageCount, run.toolUseCount, run.totalInputTokens,
        run.totalOutputTokens, run.startedAt, run.endedAt, run.fileSizeBytes
      );
  }

  /** Upsert a tool result file. */
  upsertToolResultFile(file: ToolResultFile): void {
    this.db
      .prepare(
        `INSERT INTO tool_result_files (session_id, tool_use_id, content, size_bytes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
           content = excluded.content,
           size_bytes = excluded.size_bytes`
      )
      .run(file.sessionId, file.toolUseId, file.content, file.sizeBytes);
  }

  /** Upsert pre-computed session analytics. */
  upsertSessionAnalytics(analytics: SessionAnalytics): void {
    this.db
      .prepare(
        `INSERT INTO session_analytics
         (session_id, total_input_tokens, total_output_tokens,
          total_cache_creation_tokens, total_cache_read_tokens,
          total_cache_write_5m_tokens, total_cache_write_1h_tokens,
          estimated_cost_usd, tool_breakdown, error_count, total_tool_uses,
          thinking_block_count, thinking_char_count, subagent_count,
          api_request_count, models, duration_seconds, deep_extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           total_input_tokens = excluded.total_input_tokens,
           total_output_tokens = excluded.total_output_tokens,
           total_cache_creation_tokens = excluded.total_cache_creation_tokens,
           total_cache_read_tokens = excluded.total_cache_read_tokens,
           total_cache_write_5m_tokens = excluded.total_cache_write_5m_tokens,
           total_cache_write_1h_tokens = excluded.total_cache_write_1h_tokens,
           estimated_cost_usd = excluded.estimated_cost_usd,
           tool_breakdown = excluded.tool_breakdown,
           error_count = excluded.error_count,
           total_tool_uses = excluded.total_tool_uses,
           thinking_block_count = excluded.thinking_block_count,
           thinking_char_count = excluded.thinking_char_count,
           subagent_count = excluded.subagent_count,
           api_request_count = excluded.api_request_count,
           models = excluded.models,
           duration_seconds = excluded.duration_seconds,
           deep_extracted_at = excluded.deep_extracted_at`
      )
      .run(
        analytics.sessionId, analytics.totalInputTokens, analytics.totalOutputTokens,
        analytics.totalCacheCreationTokens, analytics.totalCacheReadTokens,
        analytics.totalCacheWrite5mTokens, analytics.totalCacheWrite1hTokens,
        analytics.estimatedCostUsd, JSON.stringify(analytics.toolBreakdown),
        analytics.errorCount, analytics.totalToolUses,
        analytics.thinkingBlockCount, analytics.thinkingCharCount,
        analytics.subagentCount, analytics.apiRequestCount,
        analytics.models, analytics.durationSeconds,
        analytics.deepExtractedAt
      );
  }

  /** Check if a session has been deep-extracted. */
  isSessionDeepExtracted(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM session_analytics WHERE session_id = ?")
      .get(sessionId);
    return row !== undefined;
  }

  /** Clear all deep-extraction data for a session. */
  clearDeepDataForSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM tool_invocations WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM thinking_blocks WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM subagent_runs WHERE parent_session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM tool_result_files WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_analytics WHERE session_id = ?").run(sessionId);
    });
    tx();
  }

  /** Get session analytics for a session. */
  getSessionAnalytics(sessionId: string): SessionAnalytics | null {
    const r = this.db
      .prepare("SELECT * FROM session_analytics WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      sessionId: r.session_id as string,
      totalInputTokens: r.total_input_tokens as number,
      totalOutputTokens: r.total_output_tokens as number,
      totalCacheCreationTokens: r.total_cache_creation_tokens as number,
      totalCacheReadTokens: r.total_cache_read_tokens as number,
      totalCacheWrite5mTokens: (r.total_cache_write_5m_tokens as number) ?? 0,
      totalCacheWrite1hTokens: (r.total_cache_write_1h_tokens as number) ?? 0,
      estimatedCostUsd: r.estimated_cost_usd as number,
      toolBreakdown: JSON.parse(r.tool_breakdown as string) as Record<string, number>,
      errorCount: r.error_count as number,
      totalToolUses: r.total_tool_uses as number,
      thinkingBlockCount: r.thinking_block_count as number,
      thinkingCharCount: r.thinking_char_count as number,
      subagentCount: r.subagent_count as number,
      apiRequestCount: (r.api_request_count as number) ?? 0,
      models: r.models as string,
      durationSeconds: r.duration_seconds as number,
      deepExtractedAt: r.deep_extracted_at as string,
    };
  }

  /** Get messages for a session with optional filtering. */
  getSessionMessages(sessionId: string, options?: { entryType?: string; limit?: number; offset?: number }): SessionMessage[] {
    const params: unknown[] = [sessionId];
    let filter = "";
    if (options?.entryType) {
      filter = "AND entry_type = ?";
      params.push(options.entryType);
    }
    params.push(options?.limit ?? 200, options?.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages WHERE session_id = ? ${filter}
         ORDER BY timestamp LIMIT ? OFFSET ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      uuid: r.uuid as string,
      parentUuid: r.parent_uuid as string | null,
      entryType: r.entry_type as string,
      timestamp: r.timestamp as string,
      model: r.model as string | null,
      stopReason: r.stop_reason as string | null,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheCreationTokens: r.cache_creation_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      contentBlockCount: r.content_block_count as number,
      cwd: r.cwd as string | null,
      gitBranch: r.git_branch as string | null,
      content: (r.content as string | null) ?? null,
    }));
  }

  /** Get tool invocations for a session. */
  getToolInvocations(sessionId: string, options?: { toolName?: string }): ToolInvocation[] {
    const params: unknown[] = [sessionId];
    let filter = "";
    if (options?.toolName) {
      filter = "AND tool_name = ?";
      params.push(options.toolName);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM tool_invocations WHERE session_id = ? ${filter}
         ORDER BY timestamp`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      messageUuid: r.message_uuid as string,
      toolUseId: r.tool_use_id as string,
      toolName: r.tool_name as string,
      inputSummary: r.input_summary as string,
      isError: (r.is_error as number) === 1,
      timestamp: r.timestamp as string,
    }));
  }

  /** Get thinking blocks for a session. */
  getThinkingBlocks(sessionId: string): ThinkingBlock[] {
    const rows = this.db
      .prepare("SELECT * FROM thinking_blocks WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      messageUuid: r.message_uuid as string,
      content: r.content as string,
      contentLength: r.content_length as number,
      timestamp: r.timestamp as string,
    }));
  }

  /** FTS5 search on thinking blocks. */
  searchThinking(query: string, options?: { sessionId?: string; limit?: number }): Array<{ block: ThinkingBlock; snippet: string; rank: number }> {
    const params: unknown[] = [query];
    let filter = "";
    if (options?.sessionId) {
      filter = "AND t.session_id = ?";
      params.push(options.sessionId);
    }
    params.push(options?.limit ?? 20);

    const rows = this.db
      .prepare(
        `SELECT t.*, snippet(thinking_fts, 0, '<b>', '</b>', '...', 60) AS snippet, rank
         FROM thinking_fts
         JOIN thinking_blocks t ON t.id = thinking_fts.rowid
         WHERE thinking_fts MATCH ?
         ${filter}
         ORDER BY rank
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      block: {
        id: r.id as number,
        sessionId: r.session_id as string,
        messageUuid: r.message_uuid as string,
        content: r.content as string,
        contentLength: r.content_length as number,
        timestamp: r.timestamp as string,
      },
      snippet: r.snippet as string,
      rank: r.rank as number,
    }));
  }

  /** FTS5 search on session message content. */
  searchMessages(
    query: string,
    options?: { sessionId?: string; entryType?: string; limit?: number }
  ): Array<{ message: SessionMessage; projectName: string; snippet: string; rank: number }> {
    const params: unknown[] = [query];
    const filters: string[] = [];

    if (options?.sessionId) {
      filters.push("m.session_id = ?");
      params.push(options.sessionId);
    }
    if (options?.entryType) {
      filters.push("m.entry_type = ?");
      params.push(options.entryType);
    }

    const whereExtra = filters.length > 0 ? "AND " + filters.join(" AND ") : "";
    params.push(options?.limit ?? 20);

    const rows = this.db
      .prepare(
        `SELECT m.*, p.name AS project_name,
                snippet(session_messages_fts, 0, '<b>', '</b>', '...', 60) AS snippet,
                rank
         FROM session_messages_fts
         JOIN session_messages m ON m.id = session_messages_fts.rowid
         JOIN sessions s ON s.session_id = m.session_id
         JOIN projects p ON p.dir_name = s.project_dir_name
         WHERE session_messages_fts MATCH ?
         ${whereExtra}
         ORDER BY rank
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      message: {
        id: r.id as number,
        sessionId: r.session_id as string,
        uuid: r.uuid as string,
        parentUuid: r.parent_uuid as string | null,
        entryType: r.entry_type as string,
        timestamp: r.timestamp as string,
        model: r.model as string | null,
        stopReason: r.stop_reason as string | null,
        inputTokens: r.input_tokens as number,
        outputTokens: r.output_tokens as number,
        cacheCreationTokens: r.cache_creation_tokens as number,
        cacheReadTokens: r.cache_read_tokens as number,
        contentBlockCount: r.content_block_count as number,
        cwd: r.cwd as string | null,
        gitBranch: r.git_branch as string | null,
        content: r.content as string | null,
      },
      projectName: r.project_name as string,
      snippet: r.snippet as string,
      rank: r.rank as number,
    }));
  }

  /** Get subagent runs for a session. */
  getSubagentRuns(sessionId: string): SubagentRun[] {
    const rows = this.db
      .prepare("SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY started_at")
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      parentSessionId: r.parent_session_id as string,
      agentId: r.agent_id as string,
      jsonlPath: r.jsonl_path as string,
      prompt: r.prompt as string,
      messageCount: r.message_count as number,
      toolUseCount: r.tool_use_count as number,
      totalInputTokens: r.total_input_tokens as number,
      totalOutputTokens: r.total_output_tokens as number,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string,
      fileSizeBytes: r.file_size_bytes as number,
    }));
  }

  /** Get tool result files for a session (metadata only). */
  getToolResultFiles(sessionId: string): Array<Omit<ToolResultFile, "content">> {
    const rows = this.db
      .prepare("SELECT id, session_id, tool_use_id, size_bytes FROM tool_result_files WHERE session_id = ?")
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      toolUseId: r.tool_use_id as string,
      sizeBytes: r.size_bytes as number,
    }));
  }

  /** Get a specific tool result file with content. */
  getToolResultFile(sessionId: string, toolUseId: string): ToolResultFile | null {
    const r = this.db
      .prepare("SELECT * FROM tool_result_files WHERE session_id = ? AND tool_use_id = ?")
      .get(sessionId, toolUseId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as number,
      sessionId: r.session_id as string,
      toolUseId: r.tool_use_id as string,
      content: r.content as string,
      sizeBytes: r.size_bytes as number,
    };
  }

  /** Get aggregate analytics across all sessions. */
  getAnalyticsStats(): SystemStats["analytics"] | undefined {
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM session_analytics").get() as { c: number }).c;
    if (count === 0) return undefined;

    const totals = this.db
      .prepare(
        `SELECT
           SUM(total_input_tokens) as input,
           SUM(total_output_tokens) as output,
           SUM(total_cache_creation_tokens) as cacheCreate,
           SUM(total_cache_read_tokens) as cacheRead,
           SUM(total_cache_write_5m_tokens) as cacheWrite5m,
           SUM(total_cache_write_1h_tokens) as cacheWrite1h,
           SUM(api_request_count) as apiRequests,
           SUM(estimated_cost_usd) as cost,
           COUNT(*) as sessions
         FROM session_analytics`
      )
      .get() as Record<string, number>;

    const messages = (this.db.prepare("SELECT COUNT(*) as c FROM session_messages").get() as { c: number }).c;
    const tools = (this.db.prepare("SELECT COUNT(*) as c FROM tool_invocations").get() as { c: number }).c;
    const thinking = (this.db.prepare("SELECT COUNT(*) as c FROM thinking_blocks").get() as { c: number }).c;

    const topTools = this.db
      .prepare("SELECT tool_name as name, COUNT(*) as count FROM tool_invocations GROUP BY tool_name ORDER BY count DESC LIMIT 15")
      .all() as Array<{ name: string; count: number }>;

    const models = this.db
      .prepare("SELECT model, COUNT(*) as count FROM session_messages WHERE model IS NOT NULL GROUP BY model")
      .all() as Array<{ model: string; count: number }>;

    return {
      totalMessages: messages,
      totalToolInvocations: tools,
      totalThinkingBlocks: thinking,
      totalInputTokens: totals.input ?? 0,
      totalOutputTokens: totals.output ?? 0,
      totalCacheCreationTokens: totals.cacheCreate ?? 0,
      totalCacheReadTokens: totals.cacheRead ?? 0,
      totalCacheWrite5mTokens: totals.cacheWrite5m ?? 0,
      totalCacheWrite1hTokens: totals.cacheWrite1h ?? 0,
      totalApiRequests: totals.apiRequests ?? 0,
      totalEstimatedCostUsd: totals.cost ?? 0,
      topTools,
      modelBreakdown: Object.fromEntries(models.map((m) => [m.model, m.count])),
      sessionsDeepExtracted: totals.sessions ?? 0,
    };
  }

  // ---- Migration methods ----

  private _migrateV2(): void {
    this.db.exec(SCHEMA_V2);
  }

  private _migrateV3(): void {
    this.db.exec(SCHEMA_V3);
  }

  private _migrateV4(): void {
    this.db.exec(`
      ALTER TABLE session_analytics ADD COLUMN api_request_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_analytics ADD COLUMN total_cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_analytics ADD COLUMN total_cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0;
    `);
  }

  private _migrateV5(): void {
    // Add project_dir_name to learnings
    this.db.exec(`ALTER TABLE learnings ADD COLUMN project_dir_name TEXT NOT NULL DEFAULT ''`);
    // Backfill from projects table
    this.db.exec(`
      UPDATE learnings SET project_dir_name = COALESCE(
        (SELECT dir_name FROM projects WHERE projects.name = learnings.project_name LIMIT 1),
        learnings.project_name
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_dir ON learnings(project_dir_name)`);

    // Rebuild project_files with project_dir_name and updated unique constraint
    this.db.exec(`
      CREATE TABLE project_files_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name  TEXT NOT NULL,
        project_dir_name TEXT NOT NULL DEFAULT '',
        file_type     TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content       TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        UNIQUE(project_dir_name, relative_path)
      )
    `);
    this.db.exec(`
      INSERT INTO project_files_new
        SELECT id, project_name,
          COALESCE((SELECT dir_name FROM projects WHERE projects.name = project_files.project_name LIMIT 1), project_name),
          file_type, relative_path, content, content_hash, size_bytes, first_seen_at, last_seen_at
        FROM project_files
    `);
    this.db.exec(`DROP TABLE project_files`);
    this.db.exec(`ALTER TABLE project_files_new RENAME TO project_files`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_project_files_dir ON project_files(project_dir_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_project_files_type ON project_files(file_type)`);
  }

  private _migrateV6(): void {
    // Add content column to session_messages (nullable for backward compat)
    this.db.exec(`ALTER TABLE session_messages ADD COLUMN content TEXT`);

    // Create FTS5 table for message content search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        session_id UNINDEXED,
        entry_type UNINDEXED,
        content='session_messages',
        content_rowid='id',
        tokenize='porter'
      )
    `);

    // Sync triggers — guard against NULL content (old rows won't have it)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON session_messages
      WHEN new.content IS NOT NULL BEGIN
        INSERT INTO session_messages_fts(rowid, content, session_id, entry_type)
        VALUES (new.id, new.content, new.session_id, new.entry_type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON session_messages
      WHEN old.content IS NOT NULL BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content, session_id, entry_type)
        VALUES ('delete', old.id, old.content, old.session_id, old.entry_type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON session_messages
      WHEN old.content IS NOT NULL BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content, session_id, entry_type)
        VALUES ('delete', old.id, old.content, old.session_id, old.entry_type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_au2 AFTER UPDATE ON session_messages
      WHEN new.content IS NOT NULL BEGIN
        INSERT INTO session_messages_fts(rowid, content, session_id, entry_type)
        VALUES (new.id, new.content, new.session_id, new.entry_type);
      END
    `);
  }

  // ---- New query methods for analytics & MCP ----

  /** Get a project by its human-readable name. */
  getProjectByName(name: string): Project | null {
    const r = this.db
      .prepare("SELECT * FROM projects WHERE name = ? LIMIT 1")
      .get(name) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      dirName: r.dir_name as string,
      name: r.name as string,
      projectPath: r.project_path as string,
      sessionCount: r.session_count as number,
      hasMemory: (r.has_memory as number) === 1,
      hasClaudeMd: (r.has_claude_md as number) === 1,
      lastScannedAt: r.last_scanned_at as string,
    };
  }

  /** Get all learnings for a project by dir_name. */
  getLearningsForProject(projectDirName: string): Learning[] {
    const rows = this.db
      .prepare("SELECT * FROM learnings WHERE project_dir_name = ? ORDER BY source_type, category")
      .all(projectDirName) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      projectName: r.project_name as string,
      projectDirName: r.project_dir_name as string,
      sourceType: r.source_type as string,
      sourcePath: r.source_path as string,
      content: r.content as string,
      category: r.category as string,
      extractedAt: r.extracted_at as string,
    })) as Learning[];
  }

  /** Get tool success rates across all sessions. */
  getToolSuccessRates(): Array<{ toolName: string; total: number; errors: number; successRate: number }> {
    return this.db
      .prepare(
        `SELECT tool_name as toolName, COUNT(*) as total, SUM(is_error) as errors,
                ROUND(1.0 - (CAST(SUM(is_error) AS REAL) / COUNT(*)), 4) as successRate
         FROM tool_invocations
         GROUP BY tool_name
         ORDER BY total DESC
         LIMIT 20`
      )
      .all() as Array<{ toolName: string; total: number; errors: number; successRate: number }>;
  }

  /** Get per-model message and token stats. */
  getModelStats(): Array<{ model: string; messageCount: number; totalInputTokens: number; totalOutputTokens: number }> {
    return this.db
      .prepare(
        `SELECT model, COUNT(*) as messageCount,
                SUM(input_tokens) as totalInputTokens,
                SUM(output_tokens) as totalOutputTokens
         FROM session_messages
         WHERE model IS NOT NULL
         GROUP BY model
         ORDER BY messageCount DESC`
      )
      .all() as Array<{ model: string; messageCount: number; totalInputTokens: number; totalOutputTokens: number }>;
  }

  /** Get analytics extraction coverage per project. */
  getProjectAnalyticsCoverage(): Array<{ projectName: string; dirName: string; totalSessions: number; deepExtractedSessions: number; totalCostUsd: number }> {
    return this.db
      .prepare(
        `SELECT p.name as projectName, p.dir_name as dirName, p.session_count as totalSessions,
                COUNT(sa.session_id) as deepExtractedSessions,
                COALESCE(SUM(sa.estimated_cost_usd), 0) as totalCostUsd
         FROM projects p
         LEFT JOIN sessions s ON s.project_dir_name = p.dir_name
         LEFT JOIN session_analytics sa ON sa.session_id = s.session_id
         GROUP BY p.dir_name
         ORDER BY totalCostUsd DESC`
      )
      .all() as Array<{ projectName: string; dirName: string; totalSessions: number; deepExtractedSessions: number; totalCostUsd: number }>;
  }

  /** Get most expensive sessions. */
  getMostExpensiveSessions(limit = 10): Array<{ sessionId: string; projectName: string; estimatedCostUsd: number; durationSeconds: number; totalToolUses: number; startedAt: string }> {
    return this.db
      .prepare(
        `SELECT sa.session_id as sessionId, p.name as projectName, sa.estimated_cost_usd as estimatedCostUsd,
                sa.duration_seconds as durationSeconds, sa.total_tool_uses as totalToolUses, s.started_at as startedAt
         FROM session_analytics sa
         JOIN sessions s ON s.session_id = sa.session_id
         JOIN projects p ON p.dir_name = s.project_dir_name
         ORDER BY sa.estimated_cost_usd DESC
         LIMIT ?`
      )
      .all(limit) as Array<{ sessionId: string; projectName: string; estimatedCostUsd: number; durationSeconds: number; totalToolUses: number; startedAt: string }>;
  }

  /** Get most expensive projects. */
  getMostExpensiveProjects(): Array<{ projectName: string; totalCostUsd: number; sessionCount: number; avgCostPerSession: number }> {
    return this.db
      .prepare(
        `SELECT p.name as projectName,
                SUM(sa.estimated_cost_usd) as totalCostUsd,
                COUNT(sa.session_id) as sessionCount,
                AVG(sa.estimated_cost_usd) as avgCostPerSession
         FROM session_analytics sa
         JOIN sessions s ON s.session_id = sa.session_id
         JOIN projects p ON p.dir_name = s.project_dir_name
         GROUP BY p.dir_name
         ORDER BY totalCostUsd DESC`
      )
      .all() as Array<{ projectName: string; totalCostUsd: number; sessionCount: number; avgCostPerSession: number }>;
  }

  close(): void {
    this.db.close();
  }
}
