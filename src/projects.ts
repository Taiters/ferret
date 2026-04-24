import path from "path";
import os from "os";
import fs from "fs";
import type { ProjectMeta } from "./types.js";

const REGISTRY_PATH = path.join(os.homedir(), ".local", "share", "ferret", "registry.json");

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export interface GlobalConfig {
  model?: string;
}

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".local", "share", "ferret", "config.json");

export interface ProjectConfig {
  indexedAt: string;
  model?: string;
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".ferret", "index-info.json");
}

export function writeProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const configPath = projectConfigPath(projectRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function readProjectConfig(projectRoot: string): ProjectConfig | null {
  const configPath = projectConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as ProjectConfig;
  } catch {
    return null;
  }
}

export function readGlobalConfig(): GlobalConfig {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf8")) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const dir = path.dirname(GLOBAL_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Resolves the embedding model for a new index run.
 * Resolution order: flagValue → globalCfg → DEFAULT_EMBEDDING_MODEL
 * The globalCfg parameter is injectable for testing; omit it to use the real global config.
 */
export function resolveModel(flagValue?: string, globalCfg?: GlobalConfig): string {
  if (flagValue) return flagValue;
  const g = globalCfg ?? readGlobalConfig();
  return g.model ?? DEFAULT_EMBEDDING_MODEL;
}

export function localDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".ferret", "db");
}

export function benchmarkPath(projectRoot: string): string {
  return path.join(projectRoot, ".ferret", "benchmark.json");
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

// Walk up the directory tree from cwd looking for a .ferret/db directory.
// Returns the project root if found, null otherwise.
export function resolveProjectFromCwd(cwd = process.cwd()): string | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".ferret", "db"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
