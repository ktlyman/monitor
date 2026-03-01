/**
 * Shared scan orchestration used by both CLI and API.
 * Eliminates duplication of the ~180-line scan loop.
 */

import { readFile } from "node:fs/promises";
import type { MonitorDatabase } from "../storage/database.js";
import type { ProjectScanner } from "../collector/scanner.js";
import type { LearningExtractor } from "./extractor.js";

/** Options for a scan run. */
export interface ScanOptions {
  /** Only scan a specific project (by human-readable name). */
  projectFilter?: string;
  /** Enable deep extraction of messages, tools, thinking blocks. */
  deep?: boolean;
  /** Re-extract deep data even if already extracted. */
  force?: boolean;
}

/** Counts and stats returned after a scan completes. */
export interface ScanProgress {
  projectsFound: number;
  sessionsScanned: number;
  learningsExtracted: number;
  filesCollected: number;
  filesChanged: number;
  deepSessions: number;
  deepMessages: number;
  deepTools: number;
  deepThinking: number;
  subagents: number;
  toolResults: number;
  errors: number;
  durationMs: number;
}

/**
 * Run a full scan: discover projects, extract learnings, collect files,
 * and optionally deep-extract session data.
 *
 * @param onProject Optional callback invoked per project with a status string.
 */
export async function runScan(
  db: MonitorDatabase,
  scanner: ProjectScanner,
  extractor: LearningExtractor,
  options: ScanOptions,
  onProject?: (name: string, stats: string) => void
): Promise<ScanProgress> {
  const startTime = Date.now();
  const progress: ScanProgress = {
    projectsFound: 0,
    sessionsScanned: 0,
    learningsExtracted: 0,
    filesCollected: 0,
    filesChanged: 0,
    deepSessions: 0,
    deepMessages: 0,
    deepTools: 0,
    deepThinking: 0,
    subagents: 0,
    toolResults: 0,
    errors: 0,
    durationMs: 0,
  };

  const projects = await scanner.discoverProjects();
  progress.projectsFound = projects.length;

  for (const project of projects) {
    if (options.projectFilter && project.name !== options.projectFilter) continue;

    try {
      db.upsertProject(project);

      // ---- Sessions ----
      const jsonlPaths = await scanner.discoverSessions(project.dirName);
      for (const jsonlPath of jsonlPaths) {
        try {
          const session = await extractor.extractSessionMeta(jsonlPath, project.dirName);
          db.upsertSession(session);
          progress.sessionsScanned++;
        } catch {
          progress.errors++;
        }
      }

      // ---- Learnings ----
      db.clearLearningsForProject(project.dirName);

      const memory = await scanner.readMemoryFile(project.dirName);
      if (memory) {
        for (const l of extractor.extractFromMemory(memory, project.name, project.dirName)) {
          db.insertLearning(l);
          progress.learningsExtracted++;
        }
      }

      const claudeMd = await scanner.readClaudeMd(project.projectPath);
      if (claudeMd) {
        for (const l of extractor.extractFromClaudeMd(claudeMd, project.name, project.dirName)) {
          db.insertLearning(l);
          progress.learningsExtracted++;
        }
      }

      const rules = await scanner.readRuleFiles(project.projectPath);
      if (rules.length > 0) {
        for (const l of extractor.extractFromRules(rules, project.name, project.dirName)) {
          db.insertLearning(l);
          progress.learningsExtracted++;
        }
      }

      const agentLessons = await scanner.readAgentLessons(project.projectPath);
      if (agentLessons) {
        for (const l of extractor.extractFromAgentLessons(agentLessons, project.name, project.dirName)) {
          db.insertLearning(l);
          progress.learningsExtracted++;
        }
      }

      // ---- Project files ----
      const collectedFiles = await scanner.collectAllFiles(project);
      for (const file of collectedFiles) {
        try {
          const { changed } = db.upsertProjectFile(file);
          progress.filesCollected++;
          if (changed) progress.filesChanged++;
        } catch {
          progress.errors++;
        }
      }

      // ---- Deep extraction ----
      if (options.deep) {
        for (const jsonlPath of jsonlPaths) {
          try {
            const sessionMeta = await extractor.extractSessionMeta(jsonlPath, project.dirName);
            const sessionId = sessionMeta.sessionId;

            // Skip if already extracted and file size unchanged (incremental)
            if (!options.force) {
              const extractedSize = db.getDeepExtractedFileSize(sessionId);
              if (extractedSize !== null && extractedSize === sessionMeta.fileSizeBytes) continue;
            }

            // Clear stale data before re-extraction
            if (db.isSessionDeepExtracted(sessionId)) {
              db.clearDeepDataForSession(sessionId);
            }

            const result = await extractor.extractSessionDeep(jsonlPath, sessionId);
            db.insertSessionMessages(result.messages);
            db.insertToolInvocations(result.toolInvocations);
            db.insertThinkingBlocks(result.thinkingBlocks);

            // Subagents
            const sessionDirs = await scanner.discoverSessionDirectories(project.dirName);
            const sessionDirId = sessionDirs.find((d) => d === sessionId || jsonlPath.includes(d)) ?? sessionId;

            const subagentFiles = await scanner.discoverSubagentSessions(project.dirName, sessionDirId);
            for (const sub of subagentFiles) {
              try {
                const subRun = await extractor.extractSubagentMeta(sub.jsonlPath, sessionId, sub.agentId);
                db.upsertSubagentRun(subRun);
                progress.subagents++;
              } catch {
                progress.errors++;
              }
            }
            result.analytics.subagentCount = subagentFiles.length;
            db.upsertSessionAnalytics(result.analytics);

            // Tool result files
            const toolResultFiles = await scanner.discoverToolResultFiles(project.dirName, sessionDirId);
            for (const tr of toolResultFiles) {
              try {
                const content = await readFile(tr.filePath, "utf-8");
                db.upsertToolResultFile({
                  sessionId,
                  toolUseId: tr.toolUseId,
                  content,
                  sizeBytes: Buffer.byteLength(content, "utf-8"),
                });
                progress.toolResults++;
              } catch {
                progress.errors++;
              }
            }

            progress.deepSessions++;
            progress.deepMessages += result.messages.length;
            progress.deepTools += result.toolInvocations.length;
            progress.deepThinking += result.thinkingBlocks.length;
          } catch {
            progress.errors++;
          }
        }
      }

      onProject?.(project.name, `${jsonlPaths.length} sessions, ${collectedFiles.length} files`);
    } catch (err) {
      onProject?.(project.name, `ERROR — ${err}`);
      progress.errors++;
    }
  }

  progress.durationMs = Date.now() - startTime;
  return progress;
}
