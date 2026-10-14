import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { EXTENSION_TO_TYPE, MAX_TITLE_SCAN_BYTES } from "../../constants.js";
import type { DiagramType } from "../../types.js";

export function diagramTypeFromPath(filePath: string): DiagramType | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_TYPE[ext] ?? null;
}

// Best-effort title from the scanned file prefix. Titles past the
// window read as null; a title line cut at the window edge keeps its
// scanned part with a "…" prefix (D-007) so it never passes as exact.
export function extractDiagramTitle(request: {
  prefixText: string;
  diagramType: DiagramType;
  wasTruncated: boolean;
}): string | null {
  const pattern =
    request.diagramType === "plantuml" ? /^\s*title\s+(.+)$/m : /^\s*%%\s*title:\s*(.+)$/m;
  const match = request.prefixText.match(pattern);
  if (!match?.[1]) return null;
  const title = match[1].trim();
  const end = (match.index ?? 0) + match[0].length;
  const cut = request.wasTruncated && end >= request.prefixText.length;
  return cut ? `…${title}` : title;
}

// First bytes of a file through its already-open NOFOLLOW handle, so
// title extraction never buffers a whole diagram and never re-opens
// the path (no TOCTOU between the open and the read).
export async function readDiagramTitlePrefix(
  handle: FileHandle,
  fileSize: number,
): Promise<{ text: string; truncated: boolean }> {
  const length = Math.min(fileSize, MAX_TITLE_SCAN_BYTES);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return { text: buffer.toString("utf-8", 0, offset), truncated: fileSize > offset };
}
