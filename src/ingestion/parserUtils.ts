import crypto from "crypto";
import path from "path";
import type { ParsedChunk } from "./parserTypes.js";

export const CHUNK_LINE_LIMIT = 150;
export const WINDOW_SIZE = 100;
export const WINDOW_OVERLAP = 20;

export function uid(file: string, name: string, start: number): string {
  return crypto.createHash("md5").update(`${file}:${name}:${start}`).digest("hex").slice(0, 12);
}

export function windowChunk(
  file: string,
  name: string,
  lines: string[],
  startLine: number,
): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let offset = 0;
  while (offset < lines.length) {
    const windowLines = lines.slice(offset, offset + WINDOW_SIZE);
    const absStart = startLine + offset;
    const absEnd = absStart + windowLines.length - 1;
    chunks.push({
      id: uid(file, name, absStart),
      file,
      name: `${name} [lines ${absStart}-${absEnd}]`,
      content: windowLines.join("\n"),
      startLine: absStart,
      endLine: absEnd,
    });
    if (offset + WINDOW_SIZE >= lines.length) break;
    offset += WINDOW_SIZE - WINDOW_OVERLAP;
  }
  return chunks;
}

export function chunkPlainText(filePath: string, text: string): ParsedChunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: ParsedChunk[] = [];
  let buffer = "";
  let bufStart = 1;
  let lineCount = 1;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer && lineCount + paraLines > CHUNK_LINE_LIMIT) {
      chunks.push({
        id: uid(filePath, "para", bufStart),
        file: filePath,
        name: path.basename(filePath),
        content: buffer.trim(),
        startLine: bufStart,
        endLine: lineCount,
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
      name: path.basename(filePath),
      content: buffer.trim(),
      startLine: bufStart,
      endLine: lineCount,
    });
  }

  return chunks;
}
