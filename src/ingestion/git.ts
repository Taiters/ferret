import { simpleGit } from "simple-git";
import crypto from "crypto";
import type { ParsedChunk } from "./parserTypes.js";

const CHUNK_LINE_LIMIT = 150;
const WINDOW_SIZE = 100;
const WINDOW_OVERLAP = 20;

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /Gemfile\.lock$/,
  /poetry\.lock$/,
  /Cargo\.lock$/,
];

function uid(repoPath: string, hash: string, part: number): string {
  return crypto.createHash("md5").update(`git:${repoPath}:${hash}:${part}`).digest("hex").slice(0, 12);
}

function filterDiff(rawDiff: string): { filteredDiff: string; changedFiles: string[] } {
  const sections = rawDiff.split(/(?=^diff --git )/m);
  const changedFiles: string[] = [];
  const keptSections: string[] = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    const match = section.match(/^diff --git a\/.+ b\/(.+)/m);
    const filePath = match?.[1] ?? "";

    if (section.includes("Binary files")) continue;
    if (filePath && SKIP_FILE_PATTERNS.some((p) => p.test(filePath))) continue;

    if (filePath) changedFiles.push(filePath);
    keptSections.push(section);
  }

  return { filteredDiff: keptSections.join(""), changedFiles };
}

function makeChunk(
  repoPath: string,
  hash: string,
  date: string,
  author: string,
  message: string,
  changedFiles: string[],
  lines: string[],
  part: number,
  totalParts: number,
): ParsedChunk {
  const shortMsg = message.length > 72 ? message.slice(0, 69) + "..." : message;
  const nameSuffix = totalParts > 1 ? ` [part ${part + 1}/${totalParts}]` : "";
  const startLine = part * (WINDOW_SIZE - WINDOW_OVERLAP) + 1;
  return {
    id: uid(repoPath, hash, part),
    file: `${repoPath}/.git/log`,
    name: `commit ${hash.slice(0, 8)} (${date}): ${shortMsg}${nameSuffix}`,
    content: lines.join("\n"),
    startLine,
    endLine: startLine + lines.length - 1,
  };
}

/**
 * Ingest the last `limit` git commits from `repoPath`.
 * Returns one chunk per commit (or multiple for large diffs, using sliding windows).
 */
export async function parseGitHistory(repoPath: string, limit = 50): Promise<ParsedChunk[]> {
  const git = simpleGit(repoPath);

  let log;
  try {
    log = await git.log({ maxCount: limit, "--no-merges": null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ⚠ Git history unavailable: ${msg}`);
    return [];
  }

  const chunks: ParsedChunk[] = [];

  for (const commit of log.all) {
    const { hash, date, author_name: author, message } = commit;
    const shortDate = date.slice(0, 10);

    let rawDiff = "";
    try {
      rawDiff = await git.raw(["diff-tree", "--no-commit-id", "-p", "--no-color", hash]);
    } catch {
      // Continue without diff if unavailable
    }

    const { filteredDiff, changedFiles } = filterDiff(rawDiff);

    const header = [
      `commit ${hash.slice(0, 8)}`,
      `Date: ${shortDate}`,
      `Author: ${author}`,
      `Message: ${message.trim()}`,
      ...(changedFiles.length ? [`\nFiles changed: ${changedFiles.join(", ")}`] : []),
      "",
    ];

    const diffLines = filteredDiff ? filteredDiff.split("\n") : [];
    const allLines = [...header, ...diffLines];

    if (allLines.length <= CHUNK_LINE_LIMIT) {
      chunks.push(makeChunk(repoPath, hash, shortDate, author, message.trim(), changedFiles, allLines, 0, 1));
    } else {
      const windows: string[][] = [];
      let start = 0;
      while (start < allLines.length) {
        windows.push(allLines.slice(start, start + WINDOW_SIZE));
        if (start + WINDOW_SIZE >= allLines.length) break;
        start += WINDOW_SIZE - WINDOW_OVERLAP;
      }
      for (let i = 0; i < windows.length; i++) {
        chunks.push(makeChunk(repoPath, hash, shortDate, author, message.trim(), changedFiles, windows[i], i, windows.length));
      }
    }
  }

  return chunks;
}
