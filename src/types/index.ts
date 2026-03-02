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
  | "rules"
  | "agent_lessons";

/** Categories for learnings. */
export type LearningCategory =
  | "pattern"
  | "decision"
  | "gotcha"
  | "convention"
  | "bug"
  | "architecture";

/** A discrete learning extracted from project data. */
export interface Learning {
  /** Auto-generated storage ID */
  id?: number;
  /** Source project name (human-readable, for display) */
  projectName: string;
  /** Stable project directory name (foreign key for joins) */
  projectDirName: string;
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
  /** Filter by project display names (prefer projectDirNames for stable matching) */
  projectNames?: string[];
  /** Filter by project directory names (stable identifiers) */
  projectDirNames?: string[];
  /** Filter by source type */
  sourceTypes?: LearningSource[];
  /** Filter by category */
  categories?: LearningCategory[];
  /** Max results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ---- Project file types ----

/** Types of documentation files tracked from projects. */
export type FileType =
  | "claude_md"
  | "memory"
  | "rules"
  | "skills"
  | "commands"
  | "agent_lessons"
  | "readme"
  | "launch_config";

/** A documentation file collected from a Claude Code project. */
export interface ProjectFile {
  /** Auto-generated storage ID */
  id?: number;
  /** Source project name (human-readable, for display) */
  projectName: string;
  /** Stable project directory name (foreign key for joins) */
  projectDirName: string;
  /** File type classification */
  fileType: FileType;
  /** Relative path within the project (e.g. ".claude/rules/scanner-trust.md") */
  relativePath: string;
  /** Full file content */
  content: string;
  /** SHA-256 hash of content for change detection */
  contentHash: string;
  /** File size in bytes */
  sizeBytes: number;
  /** When this version was first seen */
  firstSeenAt: string;
  /** When this file was last updated */
  lastSeenAt: string;
}

/** A historical version of a project file. */
export interface FileVersion {
  /** Auto-generated storage ID */
  id?: number;
  /** Reference to the project_files row */
  projectFileId: number;
  /** Full content at this version */
  content: string;
  /** SHA-256 hash */
  contentHash: string;
  /** File size in bytes */
  sizeBytes: number;
  /** When this version was recorded */
  recordedAt: string;
}

// ---- Session analytics types ----

/** A single message entry extracted from a session JSONL file. */
export interface SessionMessage {
  id?: number;
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  /** Entry type: "user" | "assistant" | "system" */
  entryType: string;
  timestamp: string;
  /** Model used (assistant messages only) */
  model: string | null;
  /** Stop reason: "end_turn" | "tool_use" | "max_tokens" */
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of content blocks in this message */
  contentBlockCount: number;
  /** Working directory at time of message */
  cwd: string | null;
  /** Git branch at time of message */
  gitBranch: string | null;
  /** Message content text (may be null for sessions not re-extracted with content support) */
  content: string | null;
}

/** A tool invocation extracted from an assistant message. */
export interface ToolInvocation {
  id?: number;
  sessionId: string;
  messageUuid: string;
  toolUseId: string;
  toolName: string;
  /** JSON-serialized input (truncated to 2000 chars) */
  inputSummary: string;
  isError: boolean;
  timestamp: string;
  /** Duration from tool_use to tool_result in milliseconds. Null if not computable. */
  durationMs: number | null;
  /** Truncated tool_result content (up to 2000 chars). Null if no result. */
  resultSummary: string | null;
  /** Byte length of the tool input before truncation. */
  inputSizeBytes: number;
  /** Byte length of the tool result content. */
  resultSizeBytes: number;
}

/** A thinking block extracted from an assistant message. */
export interface ThinkingBlock {
  id?: number;
  sessionId: string;
  messageUuid: string;
  content: string;
  contentLength: number;
  timestamp: string;
}

/** A subagent session discovered in a session's subagents/ directory. */
export interface SubagentRun {
  id?: number;
  parentSessionId: string;
  agentId: string;
  jsonlPath: string;
  /** First user message content (truncated to 500 chars) */
  prompt: string;
  messageCount: number;
  toolUseCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startedAt: string;
  endedAt: string;
  fileSizeBytes: number;
}

/** A tool result file stored in a session's tool-results/ directory. */
export interface ToolResultFile {
  id?: number;
  sessionId: string;
  toolUseId: string;
  content: string;
  sizeBytes: number;
}

/** Pre-computed analytics for a session. */
export interface SessionAnalytics {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCacheWrite5mTokens: number;
  totalCacheWrite1hTokens: number;
  estimatedCostUsd: number;
  /** Tool name → count */
  toolBreakdown: Record<string, number>;
  errorCount: number;
  totalToolUses: number;
  thinkingBlockCount: number;
  thinkingCharCount: number;
  subagentCount: number;
  /** Number of actual API requests (deduplicated from streaming fragments) */
  apiRequestCount: number;
  models: string;
  durationSeconds: number;
  deepExtractedAt: string;
  /** JSONL file size in bytes at time of deep extraction (for incremental refresh). */
  deepExtractedFileSize: number;
}

/** A plan extracted from an ExitPlanMode tool invocation. */
export interface Plan {
  id?: number;
  sessionId: string;
  toolUseId: string;
  /** Full plan content (up to 50,000 chars). */
  planContent: string;
  contentLength: number;
  timestamp: string;
}

/** A single API request extracted from a session. */
export interface ApiRequest {
  id?: number;
  sessionId: string;
  /** UUID of the root assistant message (non-fragment) */
  messageUuid: string;
  /** 0-based index of this request within the session */
  requestIndex: number;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  estimatedCostUsd: number;
  stopReason: string | null;
  /** Number of tool_use blocks in this request's response */
  toolUseCount: number;
  /** Number of thinking chars in this request's response */
  thinkingCharCount: number;
}

// ---- Write-back types ----

/** An agent-authored note attached to a project or session. */
export interface Note {
  id?: number;
  /** Project directory name (required) */
  projectDirName: string;
  /** Session ID (optional — null for project-level notes) */
  sessionId: string | null;
  /** Note category: observation, decision, outcome, todo */
  category: "observation" | "decision" | "outcome" | "todo";
  /** The note content */
  content: string;
  /** When this note was created */
  createdAt: string;
}

/** A promoted runbook — a reusable sequence of steps for a common task. */
export interface Runbook {
  id?: number;
  /** Human-readable title */
  title: string;
  /** Which project this applies to (null = cross-project) */
  projectDirName: string | null;
  /** Description of when/why to use this runbook */
  description: string;
  /** Markdown steps */
  steps: string;
  /** Source: "manual" (agent-created) or "promoted" (from observed patterns) */
  source: "manual" | "promoted";
  /** Tags for categorization (comma-separated) */
  tags: string;
  createdAt: string;
  updatedAt: string;
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
  analytics?: {
    totalMessages: number;
    totalToolInvocations: number;
    totalThinkingBlocks: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheCreationTokens: number;
    totalCacheReadTokens: number;
    totalCacheWrite5mTokens: number;
    totalCacheWrite1hTokens: number;
    totalApiRequests: number;
    totalEstimatedCostUsd: number;
    topTools: Array<{ name: string; count: number }>;
    modelBreakdown: Record<string, number>;
    sessionsDeepExtracted: number;
  };
}
