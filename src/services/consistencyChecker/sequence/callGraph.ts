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

interface DefinitionMatch {
  name: string;
  declarationIndex: number;
}

/** Definition patterns that set the enclosing caller for following lines. */
const DEF_PATTERNS = [
  /(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\()/d,
  /(?:def\s+([A-Za-z_]\w*)\s*\()/d,
  /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/d,
];

/** Definition name and source position declared on this line, if any. */
function matchDefName(line: string): DefinitionMatch | null {
  for (const pattern of DEF_PATTERNS) {
    const match = pattern.exec(line);
    if (match) {
      return { name: match[1], declarationIndex: match.indices![1]![0] };
    }
  }
  return null;
}

/** True when a call-like match is construction or a keyword. */
function isSkippedCall(line: string, name: string, index: number): boolean {
  if (CALL_KEYWORDS.has(name)) return true;
  return /\bnew\s*$/.test(line.slice(0, index));
}

/** Call edges on one line attributed to the current caller. */
function extractLineCalls(
  line: string,
  lineNumber: number,
  caller: string,
  definition: DefinitionMatch | null,
): CallEdge[] {
  const edges: CallEdge[] = [];
  const hasCallbackWrapper = CALLBACK_WRAPPER_REGEX.test(line);
  CALL_SITE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_SITE_REGEX.exec(line)) !== null) {
    const name = match[1];
    const isDeclarationName = match.index === definition?.declarationIndex;
    if (isDeclarationName || isSkippedCall(line, name, match.index)) {
      continue;
    }
    edges.push({
      caller,
      callee: name,
      viaCallback: line.slice(0, match.index).includes("=>") || hasCallbackWrapper,
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
    const definition = matchDefName(line);
    if (definition) caller = definition.name;
    edges.push(...extractLineCalls(line, index + 1, caller, definition));
  }
  return edges;
}
