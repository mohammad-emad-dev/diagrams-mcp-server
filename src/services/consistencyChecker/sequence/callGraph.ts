// Ordered call graph per scanned file (Phase 2 ordering layer).
//
// One edge per call site, in source order: who calls what, where.
// The ordering check compares this sequence against diagram message order.
// Informational only: ordering findings never flip matched/unmatched verdicts.

/** One directed call observed in source order. */
export interface CallEdge {
  /** Enclosing function/method name, or "<module>" at top level. */
  caller: string;
  /** Called function/method name. */
  callee: string;
  /** True when the call sits inside a callback/promise/listener (ordering limit). */
  viaCallback: boolean;
  /** 1-based line number of the call site. */
  line: number;
}

/** Keywords that look like calls but never are. */
const CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "def",
  "class",
  "new",
  "typeof",
  "import",
  "export",
  "await",
  "yield",
  "with",
  "delete",
  "void",
  "do",
  "else",
]);

/** Call-like word followed by an opening paren. */
const CALL_SITE_REGEX = /\b([A-Za-z_$][\w$]*)\s*\(/g;

/** Wrappers that defer a call to a callback/promise/listener path. */
const CALLBACK_WRAPPER_REGEX =
  /\b(setTimeout|setInterval|setImmediate|process\.nextTick|then|catch|finally|on|once|addEventListener|addListener|subscribe|emit)\s*\(/;

/** Definition patterns that set the enclosing caller for following lines. */
const DEF_PATTERNS = [
  /(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\()/,
  /(?:def\s+([A-Za-z_]\w*)\s*\()/,
  /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
];

/** Def name declared on this line, if any. */
function matchDefName(line: string): string | null {
  for (const pattern of DEF_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** True when the text before a call puts it on a deferred path. */
function isCallbackContext(before: string, line: string): boolean {
  return before.includes("=>") || CALLBACK_WRAPPER_REGEX.test(line);
}

/** True when a call-like match is construction or a keyword. */
function isSkippedCall(line: string, name: string, index: number): boolean {
  if (CALL_KEYWORDS.has(name)) return true;
  return /\bnew\s*$/.test(line.slice(0, index));
}

/** Call edges on one line attributed to the current caller. */
function extractLineCalls(line: string, lineNumber: number, caller: string): CallEdge[] {
  const edges: CallEdge[] = [];
  const defName = matchDefName(line);
  CALL_SITE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_SITE_REGEX.exec(line)) !== null) {
    const name = match[1];
    if (name === defName || isSkippedCall(line, name, match.index)) continue;
    edges.push({
      caller,
      callee: name,
      viaCallback: isCallbackContext(line.slice(0, match.index), line),
      line: lineNumber,
    });
  }
  return edges;
}

/** Extract ordered call edges from comment/string-stripped source. */
export function extractCallEdges(stripped: string): CallEdge[] {
  const edges: CallEdge[] = [];
  let caller = "<module>";
  const lines = stripped.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const defName = matchDefName(line);
    if (defName) caller = defName;
    edges.push(...extractLineCalls(line, index + 1, caller));
  }
  return edges;
}
