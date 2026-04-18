import path from "path";
import crypto from "crypto";
import type { Chunk } from "../types.js";

const MAX_SECTION_LINES = 150;
const WINDOW_SIZE = 100;
const WINDOW_OVERLAP = 20;

function uid(file: string, heading: string, idx: number): string {
  return crypto.createHash("md5").update(`${file}:${heading}:${idx}`).digest("hex").slice(0, 12);
}

/**
 * Parse a markdown file into heading-based sections.
 * Long sections are windowed just like code.
 */
export function parseMarkdown(filePath: string, source: string): Chunk[] {
  const lines = source.split("\n");
  const chunks: Chunk[] = [];
  const heading = /^#{1,4}\s+(.+)/;

  let currentHeading = path.basename(filePath, ".md");
  let buffer: string[] = [];
  let bufferStart = 1;
  let sectionIdx = 0;

  function flush(): void {
    if (!buffer.length) return;
    const content = buffer.join("\n").trim();
    const lineCount = buffer.length;

    if (lineCount <= MAX_SECTION_LINES) {
      chunks.push({
        id: uid(filePath, currentHeading, sectionIdx++),
        file: filePath,
        category: "docs",
        name: currentHeading,
        content,
        tags: [currentHeading, path.basename(filePath), "docs"],
        start_line: bufferStart,
        end_line: bufferStart + lineCount - 1,
      });
    } else {
      // Window long sections
      let offset = 0;
      while (offset < buffer.length) {
        const win = buffer.slice(offset, offset + WINDOW_SIZE);
        const absStart = bufferStart + offset;
        chunks.push({
          id: uid(filePath, currentHeading, sectionIdx++),
          file: filePath,
          category: "docs",
          name: `${currentHeading} [part ${Math.floor(offset / (WINDOW_SIZE - WINDOW_OVERLAP)) + 1}]`,
          content: win.join("\n").trim(),
          tags: [currentHeading, path.basename(filePath), "docs"],
          start_line: absStart,
          end_line: absStart + win.length - 1,
        });
        if (offset + WINDOW_SIZE >= buffer.length) break;
        offset += WINDOW_SIZE - WINDOW_OVERLAP;
      }
    }

    buffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(heading);
    if (m) {
      flush();
      currentHeading = m[1].trim();
      bufferStart = i + 1;
      buffer = [lines[i]];
    } else {
      buffer.push(lines[i]);
    }
  }
  flush();

  return chunks;
}
