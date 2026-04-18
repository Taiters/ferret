import { simpleGit } from "simple-git";
import crypto from "crypto";
import type { Chunk } from "../types.js";

const BATCH_SIZE = 10; // commits per chunk

function uid(repoPath: string, idx: number): string {
  return crypto.createHash("md5").update(`git:${repoPath}:${idx}`).digest("hex").slice(0, 12);
}

interface CommitSummary {
  hash: string;
  date: string;
  author: string;
  message: string;
}

/**
 * Ingest the last `limit` git commits from `repoPath`.
 * Returns chunks grouped in batches of BATCH_SIZE.
 */
export async function parseGitHistory(repoPath: string, limit = 100): Promise<Chunk[]> {
  const git = simpleGit(repoPath);

  let log;
  try {
    log = await git.log({ maxCount: limit, "--no-merges": null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ⚠ Git history unavailable: ${msg}`);
    return [];
  }

  const commits: CommitSummary[] = log.all.map((c) => ({
    hash: c.hash.slice(0, 8),
    date: c.date.slice(0, 10),
    author: c.author_name,
    message: c.message.trim(),
  }));

  const chunks: Chunk[] = [];
  for (let i = 0; i < commits.length; i += BATCH_SIZE) {
    const batch = commits.slice(i, i + BATCH_SIZE);
    const content = batch
      .map((c) => `[${c.hash}] ${c.date} ${c.author}: ${c.message}`)
      .join("\n");

    const dateRange = `${batch[batch.length - 1].date} → ${batch[0].date}`;

    chunks.push({
      id: uid(repoPath, i),
      file: `${repoPath}/.git/log`,
      category: "git",
      name: `Git history ${dateRange}`,
      content,
      tags: ["git", "history", "commits"],
      start_line: i + 1,
      end_line: i + batch.length,
    });
  }

  return chunks;
}
