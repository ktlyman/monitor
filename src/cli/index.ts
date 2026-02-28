#!/usr/bin/env node

/**
 * CLI for the Monitor meta-learning system.
 * Provides commands for scanning projects, searching learnings, and serving the web UI.
 */

import { Command } from "commander";

const program = new Command();

program
  .name("monitor")
  .description(
    "Meta-learning system for Claude Code projects.\n" +
      "Scans ~/.claude/projects/ to extract and serve patterns and learnings."
  )
  .version("0.1.0");

// ---- scan ----
program
  .command("scan")
  .description("Scan ~/.claude/projects/ for new sessions and learnings")
  .option("-p, --project <name>", "scan only a specific project")
  .option("--deep", "deep extract session messages, tools, thinking blocks")
  .option("--force", "re-extract deep data even if already extracted")
  .option("--db <path>", "database path", "monitor.db")
  .action(async (opts: { project?: string; deep?: boolean; force?: boolean; db: string }) => {
    const { ProjectScanner } = await import("../collector/scanner.js");
    const { LearningExtractor } = await import("../analyzer/extractor.js");
    const { MonitorDatabase } = await import("../storage/database.js");
    const { readFile } = await import("node:fs/promises");

    const db = new MonitorDatabase(opts.db);
    const scanner = new ProjectScanner();
    const extractor = new LearningExtractor();

    console.log("Scanning ~/.claude/projects/ ...");
    const startTime = Date.now();

    const projects = await scanner.discoverProjects();
    let learningCount = 0;
    let sessionCount = 0;
    let fileCount = 0;
    let fileChangedCount = 0;
    let errorCount = 0;

    for (const project of projects) {
      if (opts.project && project.name !== opts.project) continue;

      try {
        db.upsertProject(project);

        // Scan sessions
        const jsonlPaths = await scanner.discoverSessions(project.dirName);
        for (const jsonlPath of jsonlPaths) {
          try {
            const session = await extractor.extractSessionMeta(
              jsonlPath,
              project.dirName
            );
            db.upsertSession(session);
            sessionCount++;
          } catch {
            errorCount++;
          }
        }

        // Clear and re-extract learnings for this project
        db.clearLearningsForProject(project.name);

        // MEMORY.md
        const memory = await scanner.readMemoryFile(project.dirName);
        if (memory) {
          const learnings = extractor.extractFromMemory(memory, project.name);
          for (const l of learnings) {
            db.insertLearning(l);
            learningCount++;
          }
        }

        // CLAUDE.md
        const claudeMd = await scanner.readClaudeMd(project.projectPath);
        if (claudeMd) {
          const learnings = extractor.extractFromClaudeMd(
            claudeMd,
            project.name
          );
          for (const l of learnings) {
            db.insertLearning(l);
            learningCount++;
          }
        }

        // Rules files
        const rules = await scanner.readRuleFiles(project.projectPath);
        if (rules.length > 0) {
          const learnings = extractor.extractFromRules(rules, project.name);
          for (const l of learnings) {
            db.insertLearning(l);
            learningCount++;
          }
        }

        // Agent lessons
        const agentLessons = await scanner.readAgentLessons(
          project.projectPath
        );
        if (agentLessons) {
          const learnings = extractor.extractFromAgentLessons(
            agentLessons,
            project.name
          );
          for (const l of learnings) {
            db.insertLearning(l);
            learningCount++;
          }
        }

        // Collect all project documentation files
        const collectedFiles = await scanner.collectAllFiles(project);
        for (const file of collectedFiles) {
          try {
            const { changed } = db.upsertProjectFile(file);
            fileCount++;
            if (changed) fileChangedCount++;
          } catch {
            errorCount++;
          }
        }

        console.log(
          `  ${project.name}: ${jsonlPaths.length} sessions, ${learningCount} learnings, ${collectedFiles.length} files`
        );
      } catch (err) {
        console.error(`  ${project.name}: ERROR — ${err}`);
        errorCount++;
      }
    }

    // ---- Deep extraction phase ----
    let deepSessionCount = 0;
    let deepMessageCount = 0;
    let deepToolCount = 0;
    let deepThinkingCount = 0;
    let subagentCount = 0;
    let toolResultCount = 0;

    if (opts.deep) {
      console.log("\nDeep extracting session data...");

      for (const project of projects) {
        if (opts.project && project.name !== opts.project) continue;

        const jsonlPaths = await scanner.discoverSessions(project.dirName);
        for (const jsonlPath of jsonlPaths) {
          try {
            // Get the session ID we stored earlier
            const sessionMeta = await extractor.extractSessionMeta(jsonlPath, project.dirName);
            const sessionId = sessionMeta.sessionId;

            // Skip if already extracted (unless --force)
            if (!opts.force && db.isSessionDeepExtracted(sessionId)) {
              continue;
            }

            // Clear existing deep data if re-extracting
            if (opts.force) {
              db.clearDeepDataForSession(sessionId);
            }

            const result = await extractor.extractSessionDeep(jsonlPath, sessionId);

            db.insertSessionMessages(result.messages);
            db.insertToolInvocations(result.toolInvocations);
            db.insertThinkingBlocks(result.thinkingBlocks);

            // Discover and extract subagents for this session
            const sessionDirs = await scanner.discoverSessionDirectories(project.dirName);
            const matchingDir = sessionDirs.find((d) => d === sessionId || jsonlPath.includes(d));
            const sessionDirId = matchingDir ?? sessionId;

            const subagentFiles = await scanner.discoverSubagentSessions(project.dirName, sessionDirId);
            for (const sub of subagentFiles) {
              try {
                const subRun = await extractor.extractSubagentMeta(sub.jsonlPath, sessionId, sub.agentId);
                db.upsertSubagentRun(subRun);
                subagentCount++;
              } catch {
                errorCount++;
              }
            }

            // Update analytics with subagent count
            result.analytics.subagentCount = subagentFiles.length;
            db.upsertSessionAnalytics(result.analytics);

            // Discover and store tool result files
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
                toolResultCount++;
              } catch {
                errorCount++;
              }
            }

            deepSessionCount++;
            deepMessageCount += result.messages.length;
            deepToolCount += result.toolInvocations.length;
            deepThinkingCount += result.thinkingBlocks.length;

            if (result.parseErrors > 0) {
              console.log(`  ${project.name}/${sessionId}: ${result.parseErrors} parse errors`);
            }
          } catch {
            errorCount++;
          }
        }

        console.log(`  ${project.name}: deep extracted`);
      }

      console.log(
        `\nDeep extraction: ${deepSessionCount} sessions, ${deepMessageCount} messages, ` +
        `${deepToolCount} tool invocations, ${deepThinkingCount} thinking blocks, ` +
        `${subagentCount} subagents, ${toolResultCount} tool results`
      );
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `\nDone in ${durationMs}ms: ${projects.length} projects, ${sessionCount} sessions, ${learningCount} learnings, ${fileCount} files (${fileChangedCount} changed), ${errorCount} errors`
    );

    db.close();
  });

// ---- search ----
program
  .command("search <query>")
  .description("Search across all collected learnings")
  .option("-n, --limit <n>", "max results", "20")
  .option("--project <name>", "filter by project")
  .option("--db <path>", "database path", "monitor.db")
  .action(
    async (
      query: string,
      opts: { limit: string; project?: string; db: string }
    ) => {
      const { MonitorDatabase } = await import("../storage/database.js");
      const db = new MonitorDatabase(opts.db);

      const results = db.search({
        query,
        limit: parseInt(opts.limit, 10),
        projectNames: opts.project ? [opts.project] : undefined,
      });

      if (results.length === 0) {
        console.log("No results found.");
      } else {
        for (const r of results) {
          console.log(
            `\n[${r.learning.projectName}] (${r.learning.sourceType}/${r.learning.category})`
          );
          console.log(`  ${r.learning.sourcePath}`);
          console.log(`  ${r.snippet}`);
        }
        console.log(`\n${results.length} results.`);
      }

      db.close();
    }
  );

// ---- projects ----
program
  .command("projects")
  .description("List all discovered Claude Code projects")
  .option("--db <path>", "database path", "monitor.db")
  .action(async (opts: { db: string }) => {
    const { MonitorDatabase } = await import("../storage/database.js");
    const db = new MonitorDatabase(opts.db);
    const projects = db.getProjects();

    if (projects.length === 0) {
      console.log("No projects found. Run 'monitor scan' first.");
    } else {
      console.log(`${projects.length} projects:\n`);
      for (const p of projects) {
        const flags = [
          p.hasMemory ? "MEMORY" : "",
          p.hasClaudeMd ? "CLAUDE.md" : "",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(
          `  ${p.name.padEnd(25)} ${String(p.sessionCount).padStart(3)} sessions  ${flags}`
        );
      }
    }

    db.close();
  });

// ---- stats ----
program
  .command("stats")
  .description("Show database statistics")
  .option("--db <path>", "database path", "monitor.db")
  .action(async (opts: { db: string }) => {
    const { MonitorDatabase } = await import("../storage/database.js");
    const db = new MonitorDatabase(opts.db);
    const stats = db.getStats();

    console.log(`Projects:  ${stats.totalProjects}`);
    console.log(`Sessions:  ${stats.totalSessions}`);
    console.log(`Learnings: ${stats.totalLearnings}`);

    if (Object.keys(stats.learningsBySource).length > 0) {
      console.log("\nBy source:");
      for (const [source, count] of Object.entries(stats.learningsBySource)) {
        console.log(`  ${source.padEnd(20)} ${count}`);
      }
    }

    if (Object.keys(stats.learningsByCategory).length > 0) {
      console.log("\nBy category:");
      for (const [cat, count] of Object.entries(stats.learningsByCategory)) {
        console.log(`  ${cat.padEnd(20)} ${count}`);
      }
    }

    db.close();
  });

// ---- serve ----
program
  .command("serve")
  .description("Start the web server")
  .option("-p, --port <port>", "port number", "3100")
  .action(async (_opts: { port: string }) => {
    // Dynamic import starts the server (side effect)
    await import("../server/api.js");
  });

program.parse();
