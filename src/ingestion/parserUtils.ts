import crypto from "crypto";
import path from "path";
import type { Chunk } from "../types.js";

export const CHUNK_LINE_LIMIT = 150; // functions over this get windowed
export const WINDOW_SIZE = 100; // lines per window
export const WINDOW_OVERLAP = 20; // overlap between windows

export function uid(file: string, name: string, start: number): string {
  return crypto.createHash("md5").update(`${file}:${name}:${start}`).digest("hex").slice(0, 12);
}

/**
 * Window a long function body into overlapping chunks.
 */
export function windowChunk(
  file: string,
  name: string,
  lines: string[],
  startLine: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  while (offset < lines.length) {
    const windowLines = lines.slice(offset, offset + WINDOW_SIZE);
    const absStart = startLine + offset;
    const absEnd = absStart + windowLines.length - 1;
    chunks.push({
      id: uid(file, name, absStart),
      file,
      category: "code",
      name: `${name} [lines ${absStart}-${absEnd}]`,
      content: windowLines.join("\n"),
      tags: [name, path.basename(file), "windowed"],
      start_line: absStart,
      end_line: absEnd,
    });
    if (offset + WINDOW_SIZE >= lines.length) break;
    offset += WINDOW_SIZE - WINDOW_OVERLAP;
  }
  return chunks;
}

/**
 * Fallback: plain text chunker for files that can't be parsed semantically.
 */
export function chunkPlainText(
  filePath: string,
  text: string,
  category: Chunk["category"] = "text",
): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let buffer = "";
  let bufStart = 1;
  let lineCount = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer && lineCount + paraLines > CHUNK_LINE_LIMIT) {
      chunks.push({
        id: uid(filePath, "para", bufStart),
        file: filePath,
        category,
        name: path.basename(filePath),
        content: buffer.trim(),
        tags: [path.basename(filePath), category],
        start_line: bufStart,
        end_line: lineCount,
      });
      buffer = para;
      bufStart = lineCount;
    } else {
      buffer += (buffer ? "\n\n" : "") + para;
    }
    lineCount += paraLines + 1;
  }

  if (buffer.trim()) {
    chunks.push({
      id: uid(filePath, "para", bufStart),
      file: filePath,
      category,
      name: path.basename(filePath),
      content: buffer.trim(),
      tags: [path.basename(filePath), category],
      start_line: bufStart,
      end_line: lineCount,
    });
  }

  return chunks;
}
