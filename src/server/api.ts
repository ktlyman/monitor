#!/usr/bin/env node

/**
 * HTTP API server for the Monitor web frontend.
 * Uses only Node.js built-ins (no express).
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorDatabase } from "../storage/database.js";
import { ProjectScanner } from "../collector/scanner.js";
import { LearningExtractor } from "../analyzer/extractor.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const STATIC_DIR = resolve(__dirname, "../static");
const PORT = parseInt(process.env.PORT ?? "3100", 10);
const DB_PATH = process.env.DB_PATH ?? "monitor.db";

const db = new MonitorDatabase(DB_PATH);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function serveStatic(
  res: ServerResponse,
  filePath: string
): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    sendError(res, "Not found", 404);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  try {
    // ---- API routes ----

    if (pathname === "/api/health" && method === "GET") {
      sendJson(res, { status: "ok" });
      return;
    }

    if (pathname === "/api/stats" && method === "GET") {
      const stats = db.getStats();
      sendJson(res, stats);
      return;
    }

    if (pathname === "/api/projects" && method === "GET") {
      const projects = db.getProjects();
      const enriched = projects.map((p) => ({
        ...p,
        fileCount: db.getProjectFiles(p.name).length,
      }));
      sendJson(res, { projects: enriched });
      return;
    }

    if (pathname === "/api/search" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const query = body.query as string | undefined;
      if (!query) {
        sendError(res, "Missing query parameter");
        return;
      }
      const results = db.search({
        query,
        limit: (body.limit as number) ?? 20,
        projectNames: body.projectNames as string[] | undefined,
      });
      sendJson(res, { results });
      return;
    }

    // POST /api/scan — run the scanner (accepts { deep?: boolean })
    if (pathname === "/api/scan" && method === "POST") {
      let deep = false;
      try {
        const bodyText = await readBody(req);
        if (bodyText) {
          const body = JSON.parse(bodyText) as Record<string, unknown>;
          deep = body.deep === true;
        }
      } catch {
        // No body or invalid JSON is fine — defaults to non-deep scan
      }

      const scanner = new ProjectScanner();
      const extractor = new LearningExtractor();
      const startTime = Date.now();

      const projects = await scanner.discoverProjects();
      let sessionCount = 0;
      let learningCount = 0;
      let fileCount = 0;
      let fileChangedCount = 0;
      let errorCount = 0;
      let deepSessionCount = 0;
      let deepMessageCount = 0;
      let deepToolCount = 0;
      let deepThinkingCount = 0;

      for (const project of projects) {
        try {
          db.upsertProject(project);

          const jsonlPaths = await scanner.discoverSessions(project.dirName);
          for (const jsonlPath of jsonlPaths) {
            try {
              const session = await extractor.extractSessionMeta(jsonlPath, project.dirName);
              db.upsertSession(session);
              sessionCount++;
            } catch {
              errorCount++;
            }
          }

          db.clearLearningsForProject(project.name);

          const memory = await scanner.readMemoryFile(project.dirName);
          if (memory) {
            for (const l of extractor.extractFromMemory(memory, project.name)) {
              db.insertLearning(l);
              learningCount++;
            }
          }

          const claudeMd = await scanner.readClaudeMd(project.projectPath);
          if (claudeMd) {
            for (const l of extractor.extractFromClaudeMd(claudeMd, project.name)) {
              db.insertLearning(l);
              learningCount++;
            }
          }

          const rules = await scanner.readRuleFiles(project.projectPath);
          if (rules.length > 0) {
            for (const l of extractor.extractFromRules(rules, project.name)) {
              db.insertLearning(l);
              learningCount++;
            }
          }

          const agentLessons = await scanner.readAgentLessons(project.projectPath);
          if (agentLessons) {
            for (const l of extractor.extractFromAgentLessons(agentLessons, project.name)) {
              db.insertLearning(l);
              learningCount++;
            }
          }

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

          // Deep extraction for this project's sessions
          if (deep) {
            for (const jsonlPath of jsonlPaths) {
              try {
                const sessionMeta = await extractor.extractSessionMeta(jsonlPath, project.dirName);
                const sessionId = sessionMeta.sessionId;
                if (db.isSessionDeepExtracted(sessionId)) continue;

                const result = await extractor.extractSessionDeep(jsonlPath, sessionId);
                db.insertSessionMessages(result.messages);
                db.insertToolInvocations(result.toolInvocations);
                db.insertThinkingBlocks(result.thinkingBlocks);

                const sessionDirs = await scanner.discoverSessionDirectories(project.dirName);
                const sessionDirId = sessionDirs.find((d) => d === sessionId || jsonlPath.includes(d)) ?? sessionId;

                const subagentFiles = await scanner.discoverSubagentSessions(project.dirName, sessionDirId);
                for (const sub of subagentFiles) {
                  try {
                    const subRun = await extractor.extractSubagentMeta(sub.jsonlPath, sessionId, sub.agentId);
                    db.upsertSubagentRun(subRun);
                  } catch { errorCount++; }
                }
                result.analytics.subagentCount = subagentFiles.length;
                db.upsertSessionAnalytics(result.analytics);

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
                  } catch { errorCount++; }
                }

                deepSessionCount++;
                deepMessageCount += result.messages.length;
                deepToolCount += result.toolInvocations.length;
                deepThinkingCount += result.thinkingBlocks.length;
              } catch { errorCount++; }
            }
          }
        } catch {
          errorCount++;
        }
      }

      const durationMs = Date.now() - startTime;
      sendJson(res, {
        projects: projects.length,
        sessions: sessionCount,
        learnings: learningCount,
        files: fileCount,
        filesChanged: fileChangedCount,
        errors: errorCount,
        durationMs,
        deep: deep ? { sessions: deepSessionCount, messages: deepMessageCount, tools: deepToolCount, thinking: deepThinkingCount } : undefined,
      });
      return;
    }

    // GET /api/files/:project — list files for a project
    const filesMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
    if (filesMatch && method === "GET") {
      const projectName = decodeURIComponent(filesMatch[1]);
      const files = db.getProjectFiles(projectName);
      // Return metadata without full content for listing
      const listing = files.map((f) => ({
        id: f.id,
        projectName: f.projectName,
        fileType: f.fileType,
        relativePath: f.relativePath,
        contentHash: f.contentHash,
        sizeBytes: f.sizeBytes,
        firstSeenAt: f.firstSeenAt,
        lastSeenAt: f.lastSeenAt,
      }));
      sendJson(res, { files: listing });
      return;
    }

    // GET /api/files/:project/content?path=<relativePath> — get file content
    const fileContentMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/);
    if (fileContentMatch && method === "GET") {
      const projectName = decodeURIComponent(fileContentMatch[1]);
      const relativePath = url.searchParams.get("path");
      if (!relativePath) {
        sendError(res, "Missing path query parameter");
        return;
      }
      const file = db.getProjectFile(projectName, relativePath);
      if (!file) {
        sendError(res, "File not found", 404);
        return;
      }
      sendJson(res, { file });
      return;
    }

    // GET /api/files/:project/versions?path=<relativePath> — get version history
    const fileVersionsMatch = pathname.match(/^\/api\/files\/([^/]+)\/versions$/);
    if (fileVersionsMatch && method === "GET") {
      const projectName = decodeURIComponent(fileVersionsMatch[1]);
      const relativePath = url.searchParams.get("path");
      if (!relativePath) {
        sendError(res, "Missing path query parameter");
        return;
      }
      const file = db.getProjectFile(projectName, relativePath);
      if (!file) {
        sendError(res, "File not found", 404);
        return;
      }
      const versions = db.getFileVersions(file.id!);
      sendJson(res, { file, versions });
      return;
    }

    // ---- Session analytics routes ----

    // GET /api/sessions/project/:projectDirName — sessions for a project with analytics
    const sessionsListMatch = pathname.match(/^\/api\/sessions\/project\/([^/]+)$/);
    if (sessionsListMatch && method === "GET") {
      const projectDirName = decodeURIComponent(sessionsListMatch[1]);
      const sessions = db.getSessions(projectDirName);
      sendJson(res, { sessions });
      return;
    }

    // GET /api/sessions/:sessionId/messages?type=&limit=&offset=
    const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === "GET") {
      const sessionId = decodeURIComponent(messagesMatch[1]);
      const entryType = url.searchParams.get("type") ?? undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const messages = db.getSessionMessages(sessionId, { entryType, limit, offset });
      sendJson(res, { messages });
      return;
    }

    // GET /api/sessions/:sessionId/tools?name=
    const toolsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tools$/);
    if (toolsMatch && method === "GET") {
      const sessionId = decodeURIComponent(toolsMatch[1]);
      const toolName = url.searchParams.get("name") ?? undefined;
      const tools = db.getToolInvocations(sessionId, { toolName });
      sendJson(res, { tools });
      return;
    }

    // GET /api/sessions/:sessionId/thinking
    const thinkingMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/thinking$/);
    if (thinkingMatch && method === "GET") {
      const sessionId = decodeURIComponent(thinkingMatch[1]);
      const blocks = db.getThinkingBlocks(sessionId);
      sendJson(res, { blocks });
      return;
    }

    // GET /api/sessions/:sessionId/subagents
    const subagentsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/subagents$/);
    if (subagentsMatch && method === "GET") {
      const sessionId = decodeURIComponent(subagentsMatch[1]);
      const subagents = db.getSubagentRuns(sessionId);
      sendJson(res, { subagents });
      return;
    }

    // GET /api/sessions/:sessionId/tool-results
    const toolResultsListMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tool-results$/);
    if (toolResultsListMatch && method === "GET") {
      const sessionId = decodeURIComponent(toolResultsListMatch[1]);
      const results = db.getToolResultFiles(sessionId);
      sendJson(res, { results });
      return;
    }

    // GET /api/sessions/:sessionId/tool-results/:toolUseId
    const toolResultMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tool-results\/([^/]+)$/);
    if (toolResultMatch && method === "GET") {
      const sessionId = decodeURIComponent(toolResultMatch[1]);
      const toolUseId = decodeURIComponent(toolResultMatch[2]);
      const result = db.getToolResultFile(sessionId, toolUseId);
      if (!result) {
        sendError(res, "Tool result not found", 404);
        return;
      }
      sendJson(res, { result });
      return;
    }

    // GET /api/sessions/:sessionId/analytics
    const sessionAnalyticsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/analytics$/);
    if (sessionAnalyticsMatch && method === "GET") {
      const sessionId = decodeURIComponent(sessionAnalyticsMatch[1]);
      const analytics = db.getSessionAnalytics(sessionId);
      if (!analytics) {
        sendError(res, "No analytics found for session", 404);
        return;
      }
      sendJson(res, { analytics });
      return;
    }

    // POST /api/search/thinking — FTS5 search on thinking blocks
    if (pathname === "/api/search/thinking" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const query = body.query as string | undefined;
      if (!query) {
        sendError(res, "Missing query parameter");
        return;
      }
      const results = db.searchThinking(query, {
        sessionId: body.sessionId as string | undefined,
        limit: (body.limit as number) ?? 20,
      });
      sendJson(res, { results });
      return;
    }

    // GET /api/analytics/summary — global analytics aggregates
    if (pathname === "/api/analytics/summary" && method === "GET") {
      const analytics = db.getAnalyticsStats();
      sendJson(res, { analytics: analytics ?? null });
      return;
    }

    // ---- Static file serving (SPA fallback) ----
    if (method === "GET") {
      if (pathname === "/" || pathname === "/index.html") {
        serveStatic(res, resolve(STATIC_DIR, "index.html"));
        return;
      }
      const safePath = pathname.replace(/\.\./g, "");
      serveStatic(res, resolve(STATIC_DIR, safePath.slice(1)));
      return;
    }

    sendError(res, "Not found", 404);
  } catch (err) {
    console.error("Request error:", err);
    sendError(res, "Internal server error", 500);
  }
});

server.listen(PORT, () => {
  console.log(`Monitor web server listening on http://localhost:${PORT}`);
});
