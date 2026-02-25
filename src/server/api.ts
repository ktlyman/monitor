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
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const STATIC_DIR = resolve(__dirname, "../static");
const PORT = parseInt(process.env.PORT ?? "3100", 10);

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

// ---- Route handlers ----

// TODO: Wire up MonitorDatabase for API routes
// TODO: Add routes: GET /api/projects, GET /api/stats, POST /api/search,
//       GET /api/learnings, GET /api/projects/:name

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

  // API routes
  if (pathname === "/api/health" && method === "GET") {
    sendJson(res, { status: "ok" });
    return;
  }

  // Static file serving (SPA fallback)
  if (method === "GET") {
    if (pathname === "/" || pathname === "/index.html") {
      serveStatic(res, resolve(STATIC_DIR, "index.html"));
      return;
    }
    // Try serving the file from static dir
    const safePath = pathname.replace(/\.\./g, "");
    serveStatic(res, resolve(STATIC_DIR, safePath.slice(1)));
    return;
  }

  sendError(res, "Not found", 404);
});

server.listen(PORT, () => {
  console.log(`Monitor web server listening on http://localhost:${PORT}`);
});
