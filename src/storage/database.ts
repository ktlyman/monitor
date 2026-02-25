import Database from "better-sqlite3";
import type {
  Learning,
  Project,
  Session,
  SearchOptions,
  SearchResult,
  SystemStats,
} from "../types/index.js";

const SCHEMA_VERSION = 1;

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

/**
 * SQLite persistence layer for the Monitor system.
 * All SQL lives in this file. Uses FTS5 for full-text search.
 */
export class MonitorDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
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
      // Future migrations go here: if (currentVersion < 2) this._migrateV2();
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

  // ---- Learning methods ----

  insertLearning(learning: Learning): number {
    const result = this.db
      .prepare(
        `INSERT INTO learnings (project_name, source_type, source_path, content, category, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        learning.projectName,
        learning.sourceType,
        learning.sourcePath,
        learning.content,
        learning.category,
        learning.extractedAt
      );
    return Number(result.lastInsertRowid);
  }

  clearLearningsForProject(projectName: string): void {
    this.db
      .prepare("DELETE FROM learnings WHERE project_name = ?")
      .run(projectName);
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
                (SELECT COUNT(*) FROM learnings l WHERE l.project_name = p.name) as learnings,
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
    };
  }

  close(): void {
    this.db.close();
  }
}
