/**
 * Path redaction utilities for API responses.
 * Replaces absolute home-directory paths with ~ to avoid
 * exposing usernames in API output.
 */

import { homedir } from "node:os";

const HOME = homedir();

/** Redact home directory from a path. */
export function redactPath(path: string | null | undefined): string | null {
  if (path == null) return null;
  if (path.startsWith(HOME)) {
    return "~" + path.slice(HOME.length);
  }
  return path;
}

/** Redact sensitive paths from a project record. */
export function redactProject<T extends Record<string, unknown>>(project: T): T {
  return {
    ...project,
    projectPath: redactPath(project.projectPath as string | null),
  };
}

/** Redact sensitive paths from a session record. */
export function redactSession<T extends Record<string, unknown>>(session: T): T {
  return {
    ...session,
    jsonlPath: redactPath(session.jsonlPath as string | null),
  };
}

/** Redact sensitive paths from a session message record. */
export function redactMessage<T extends Record<string, unknown>>(message: T): T {
  return {
    ...message,
    cwd: redactPath(message.cwd as string | null),
  };
}

/** Redact sensitive paths from a subagent record. */
export function redactSubagent<T extends Record<string, unknown>>(sub: T): T {
  return {
    ...sub,
    jsonlPath: redactPath(sub.jsonlPath as string | null),
  };
}
