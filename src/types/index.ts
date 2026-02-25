/** Core type definitions for the Monitor meta-learning system. */

// ---- Project types ----

/** A discovered Claude Code project. */
export interface Project {
  /** Directory name in ~/.claude/projects/ (e.g. "-Users-kevin-Projects-listener") */
  dirName: string;
  /** Human-readable project name extracted from path (e.g. "listener") */
  name: string;
  /** Absolute path to the project's source code */
  projectPath: string;
  /** Number of session JSONL files found */
  sessionCount: number;
  /** Whether a MEMORY.md exists */
  hasMemory: boolean;
  /** Whether a CLAUDE.md exists in the project root */
  hasClaudeMd: boolean;
  /** When this project was last scanned */
  lastScannedAt: string;
}

// ---- Session types ----

/** A Claude Code session parsed from a JSONL file. */
export interface Session {
  /** UUID session identifier */
  sessionId: string;
  /** Parent project directory name */
  projectDirName: string;
  /** Absolute path to the JSONL file */
  jsonlPath: string;
  /** First message timestamp */
  startedAt: string;
  /** Last message timestamp */
  endedAt: string;
  /** Number of user messages */
  userMessageCount: number;
  /** Number of assistant messages */
  assistantMessageCount: number;
  /** Number of tool use blocks */
  toolUseCount: number;
  /** File size in bytes */
  fileSizeBytes: number;
}

// ---- Learning types ----

/** Source types for learnings. */
export type LearningSource =
  | "memory"
  | "claude_md"
  | "session"
  | "rules"
  | "agent_lessons"
  | "skills";

/** Categories for learnings. */
export type LearningCategory =
  | "pattern"
  | "decision"
  | "gotcha"
  | "convention"
  | "bug"
  | "architecture"
  | "tool_usage";

/** A discrete learning extracted from project data. */
export interface Learning {
  /** Auto-generated storage ID */
  id?: number;
  /** Source project name */
  projectName: string;
  /** Source type */
  sourceType: LearningSource;
  /** Source file path (relative to project) */
  sourcePath: string;
  /** The extracted learning text */
  content: string;
  /** Category */
  category: LearningCategory;
  /** When this learning was extracted */
  extractedAt: string;
}

// ---- Search types ----

/** Result from a full-text search. */
export interface SearchResult {
  learning: Learning;
  /** FTS5 snippet with match highlighting */
  snippet: string;
  /** BM25 relevance rank */
  rank: number;
}

/** Options for searching learnings. */
export interface SearchOptions {
  /** Free-text search query */
  query: string;
  /** Filter by project names */
  projectNames?: string[];
  /** Filter by source type */
  sourceTypes?: LearningSource[];
  /** Filter by category */
  categories?: LearningCategory[];
  /** Max results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ---- Scan types ----

/** Result of a scan operation. */
export interface ScanResult {
  /** Projects discovered */
  projectsFound: number;
  /** Sessions parsed */
  sessionsParsed: number;
  /** Learnings extracted */
  learningsExtracted: number;
  /** Errors encountered (non-fatal) */
  errors: string[];
  /** Duration in milliseconds */
  durationMs: number;
}

/** Stats overview of the database. */
export interface SystemStats {
  totalProjects: number;
  totalSessions: number;
  totalLearnings: number;
  learningsBySource: Record<string, number>;
  learningsByCategory: Record<string, number>;
  projects: Array<{
    name: string;
    sessions: number;
    learnings: number;
    lastScanned: string;
  }>;
}
