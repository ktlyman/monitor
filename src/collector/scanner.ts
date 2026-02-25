import { readdir, stat, readFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Project } from "../types/index.js";

/** Default base directory for Claude Code project data. */
const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Discovers Claude Code projects and their session files.
 * Reads from ~/.claude/projects/ without modifying any data.
 */
export class ProjectScanner {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  }

  /** Discover all project directories and build Project metadata. */
  async discoverProjects(): Promise<Project[]> {
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const projects: Project[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const dirPath = join(this.baseDir, entry.name);
      const project = await this._buildProject(entry.name, dirPath);
      if (project) projects.push(project);
    }

    return projects;
  }

  /** List session JSONL files for a project directory. */
  async discoverSessions(projectDirName: string): Promise<string[]> {
    const dirPath = join(this.baseDir, projectDirName);
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(dirPath, e.name));
  }

  /** Read MEMORY.md from a project's memory/ subdirectory. */
  async readMemoryFile(projectDirName: string): Promise<string | null> {
    const memoryPath = join(
      this.baseDir,
      projectDirName,
      "memory",
      "MEMORY.md"
    );
    return this._readFileIfExists(memoryPath);
  }

  /** Read CLAUDE.md from the project's source directory. */
  async readClaudeMd(projectPath: string): Promise<string | null> {
    const claudePath = join(projectPath, "CLAUDE.md");
    return this._readFileIfExists(claudePath);
  }

  /** Read .claude/rules/ files from the project's source directory. */
  async readRuleFiles(
    projectPath: string
  ): Promise<Array<{ path: string; content: string }>> {
    const rulesDir = join(projectPath, ".claude", "rules");
    const results: Array<{ path: string; content: string }> = [];

    try {
      const entries = await readdir(rulesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(rulesDir, entry.name);
        const content = await readFile(filePath, "utf-8");
        results.push({ path: entry.name, content });
      }
    } catch {
      // Rules directory may not exist — that's fine
    }

    return results;
  }

  /** Read .claude/agent-lessons.md or agent-learnings.md if present. */
  async readAgentLessons(projectPath: string): Promise<string | null> {
    for (const name of ["agent-lessons.md", "agent-learnings.md"]) {
      const content = await this._readFileIfExists(
        join(projectPath, ".claude", name)
      );
      if (content) return content;
    }
    return null;
  }

  /** Extract the human-readable project name from a directory name. */
  static parseProjectName(dirName: string): string {
    // Format: "-Users-kevin-Projects-<name>" or "-Users-kevin-testing-<name>"
    const parts = dirName.split("-").filter(Boolean);
    return parts[parts.length - 1] ?? dirName;
  }

  /** Derive the source project path from the encoded directory name. */
  static deriveProjectPath(dirName: string): string {
    // Directory name encodes the path with dashes replacing slashes
    return "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
  }

  // ---- Private helpers ----

  private async _buildProject(
    dirName: string,
    dirPath: string
  ): Promise<Project | null> {
    try {
      const jsonlFiles = await this.discoverSessions(dirName);
      const memoryContent = await this.readMemoryFile(dirName);
      const projectPath = ProjectScanner.deriveProjectPath(dirName);
      const claudeMdExists = await this._fileExists(
        join(projectPath, "CLAUDE.md")
      );

      return {
        dirName,
        name: ProjectScanner.parseProjectName(dirName),
        projectPath,
        sessionCount: jsonlFiles.length,
        hasMemory: memoryContent !== null,
        hasClaudeMd: claudeMdExists,
        lastScannedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async _readFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
