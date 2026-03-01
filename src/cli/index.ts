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
    const { runScan } = await import("../analyzer/scan-service.js");

    const db = new MonitorDatabase(opts.db);
    const scanner = new ProjectScanner();
    const extractor = new LearningExtractor();

    console.log("Scanning ~/.claude/projects/ ...");

    const progress = await runScan(db, scanner, extractor, {
      projectFilter: opts.project,
      deep: opts.deep,
      force: opts.force,
    }, (name, stats) => {
      console.log(`  ${name}: ${stats}`);
    });

    if (progress.deepSessions > 0) {
      console.log(
        `\nDeep extraction: ${progress.deepSessions} sessions, ${progress.deepMessages} messages, ` +
        `${progress.deepTools} tool invocations, ${progress.deepThinking} thinking blocks, ` +
        `${progress.subagents} subagents, ${progress.toolResults} tool results`
      );
    }

    console.log(
      `\nDone in ${progress.durationMs}ms: ${progress.projectsFound} projects, ${progress.sessionsScanned} sessions, ` +
      `${progress.learningsExtracted} learnings, ${progress.filesCollected} files (${progress.filesChanged} changed), ${progress.errors} errors`
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

      const resolved = opts.project ? db.resolveProject(opts.project) : null;
      const results = db.search({
        query,
        limit: parseInt(opts.limit, 10),
        projectDirNames: resolved ? [resolved.dirName] : undefined,
        projectNames: !resolved && opts.project ? [opts.project] : undefined,
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
  .action(async (opts: { port: string }) => {
    process.env.PORT = opts.port;
    // Dynamic import starts the server (side effect)
    await import("../server/api.js");
  });

program.parse();
