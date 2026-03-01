import { readdir, stat, readFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { FileType, Project } from "../types/index.js";

/** A collected file with its type and content. */
export interface CollectedFile {
  projectName: string;
  projectDirName: string;
  fileType: FileType;
  relativePath: string;
  content: string;
}

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

  /** Read .claude/rules/ files recursively from the project's source directory. */
  async readRuleFiles(
    projectPath: string
  ): Promise<Array<{ path: string; content: string }>> {
    const collected: CollectedFile[] = [];
    await this._collectDirFiles(
      join(projectPath, ".claude", "rules"), "", "", "rules", "", collected
    );
    return collected.map((f) => ({ path: f.relativePath, content: f.content }));
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

  /**
   * Collect all documentation files from a project.
   * Gathers from both the ~/.claude/projects/ data dir and the project source path.
   */
  async collectAllFiles(project: Project): Promise<CollectedFile[]> {
    const files: CollectedFile[] = [];
    const pn = project.name;
    const pd = project.dirName;

    // MEMORY.md from ~/.claude/projects/<dir>/memory/
    const memory = await this.readMemoryFile(project.dirName);
    if (memory) {
      files.push({ projectName: pn, projectDirName: pd, fileType: "memory", relativePath: "memory/MEMORY.md", content: memory });
    }

    // Also check for other .md files in the memory/ directory
    await this._collectDirFiles(join(this.baseDir, project.dirName, "memory"), pn, pd, "memory", "memory/", files, ["MEMORY.md"]);

    // CLAUDE.md from project source root
    const claudeMd = await this._readFileIfExists(join(project.projectPath, "CLAUDE.md"));
    if (claudeMd) {
      files.push({ projectName: pn, projectDirName: pd, fileType: "claude_md", relativePath: "CLAUDE.md", content: claudeMd });
    }

    // README.md from project source root
    const readme = await this._readFileIfExists(join(project.projectPath, "README.md"));
    if (readme) {
      files.push({ projectName: pn, projectDirName: pd, fileType: "readme", relativePath: "README.md", content: readme });
    }

    // .claude/rules/**/*.md (recursive)
    await this._collectDirFiles(join(project.projectPath, ".claude", "rules"), pn, pd, "rules", ".claude/rules/", files);

    // .claude/agent-lessons.md or agent-learnings.md
    for (const name of ["agent-lessons.md", "agent-learnings.md"]) {
      const content = await this._readFileIfExists(join(project.projectPath, ".claude", name));
      if (content) {
        files.push({ projectName: pn, projectDirName: pd, fileType: "agent_lessons", relativePath: `.claude/${name}`, content });
      }
    }

    // .claude/skills/**/*.md
    await this._collectDirFiles(join(project.projectPath, ".claude", "skills"), pn, pd, "skills", ".claude/skills/", files);

    // .claude/commands/**/*.md
    await this._collectDirFiles(join(project.projectPath, ".claude", "commands"), pn, pd, "commands", ".claude/commands/", files);

    // .claude/launch.json
    const launchConfig = await this._readFileIfExists(join(project.projectPath, ".claude", "launch.json"));
    if (launchConfig) {
      files.push({ projectName: pn, projectDirName: pd, fileType: "launch_config", relativePath: ".claude/launch.json", content: launchConfig });
    }

    return files;
  }

  /** Discover session directories (that contain subagents/ and tool-results/). */
  async discoverSessionDirectories(projectDirName: string): Promise<string[]> {
    const dirPath = join(this.baseDir, projectDirName);
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "memory")
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Discover subagent JSONL files for a specific session. */
  async discoverSubagentSessions(
    projectDirName: string,
    sessionId: string
  ): Promise<Array<{ agentId: string; jsonlPath: string }>> {
    const subagentsDir = join(this.baseDir, projectDirName, sessionId, "subagents");
    try {
      const entries = await readdir(subagentsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
        .map((e) => ({
          agentId: e.name.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
          jsonlPath: join(subagentsDir, e.name),
        }));
    } catch {
      return [];
    }
  }

  /** Discover tool result text files for a specific session. */
  async discoverToolResultFiles(
    projectDirName: string,
    sessionId: string
  ): Promise<Array<{ toolUseId: string; filePath: string }>> {
    const resultsDir = join(this.baseDir, projectDirName, sessionId, "tool-results");
    try {
      const entries = await readdir(resultsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".txt"))
        .map((e) => ({
          toolUseId: e.name.replace(/\.txt$/, ""),
          filePath: join(resultsDir, e.name),
        }));
    } catch {
      return [];
    }
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

  /** Recursively collect .md files from a directory. */
  private async _collectDirFiles(
    dirPath: string,
    projectName: string,
    projectDirName: string,
    fileType: FileType,
    relativePrefix: string,
    results: CollectedFile[],
    exclude: string[] = []
  ): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (exclude.includes(entry.name)) continue;
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this._collectDirFiles(
            fullPath,
            projectName,
            projectDirName,
            fileType,
            `${relativePrefix}${entry.name}/`,
            results,
            exclude
          );
        } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
          const content = await this._readFileIfExists(fullPath);
          if (content) {
            results.push({
              projectName,
              projectDirName,
              fileType,
              relativePath: `${relativePrefix}${entry.name}`,
              content,
            });
          }
        }
      }
    } catch {
      // Directory may not exist — that's fine
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
