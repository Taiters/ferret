import path from "path";
import os from "os";
import fs from "fs";
import type { ProjectMeta } from "./types.js";

const REGISTRY_PATH = path.join(os.homedir(), ".local", "share", "memory-skill", "registry.json");

export function localDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".memory-skill", "db");
}

export function readRegistry(): ProjectMeta[] {
  if (!fs.existsSync(REGISTRY_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    return (data.projects ?? []) as ProjectMeta[];
  } catch {
    return [];
  }
}

export function registerProject(projectRoot: string): void {
  const dir = path.dirname(REGISTRY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const projects = readRegistry().filter((p) => p.path !== projectRoot);
  projects.unshift({
    path: projectRoot,
    name: path.basename(projectRoot),
    indexedAt: new Date().toISOString(),
  });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects }, null, 2));
}

// Walk up the directory tree from cwd looking for a .memory-skill/db directory.
// Returns the project root if found, null otherwise.
export function resolveProjectFromCwd(cwd = process.cwd()): string | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".memory-skill", "db"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
