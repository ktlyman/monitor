import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { isPathWithinDir } from "../src/server/api.js";

describe("isPathWithinDir", () => {
  const baseDir = "/srv/static";

  it("allows a file directly inside the base directory", () => {
    const resolved = resolve(baseDir, "index.html");
    expect(isPathWithinDir(baseDir, resolved)).toBe(true);
  });

  it("allows nested file paths", () => {
    const resolved = resolve(baseDir, "css/style.css");
    expect(isPathWithinDir(baseDir, resolved)).toBe(true);
  });

  it("allows the base directory itself", () => {
    expect(isPathWithinDir(baseDir, baseDir)).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    const resolved = resolve(baseDir, "../etc/passwd");
    expect(isPathWithinDir(baseDir, resolved)).toBe(false);
  });

  it("rejects deep path traversal", () => {
    const resolved = resolve(baseDir, "../../etc/shadow");
    expect(isPathWithinDir(baseDir, resolved)).toBe(false);
  });

  it("rejects sibling directory with common prefix", () => {
    // /srv/static-extra should not match /srv/static
    expect(isPathWithinDir("/srv/static", "/srv/static-extra/file.txt")).toBe(false);
  });

  it("rejects absolute path that escapes base", () => {
    // resolve() with an absolute subpath replaces the base entirely
    const resolved = resolve(baseDir, "/etc/passwd");
    expect(isPathWithinDir(baseDir, resolved)).toBe(false);
  });
});
