// Sequence collection for diagrams_generate_sequence: turn the ordered
// caller->callee edges found in a codebase slice into a starter sequence
// diagram.
//
// Reuses the consistency checker's ordered call graph (AST edges when the
// TypeScript compiler resolves, extractCallEdges otherwise) and the generate
// tool's scan stack, so "what is a call" and "what is declared" mean the same
// thing here as in diagrams_check_consistency and diagrams_generate. This is
// the generative flip side of the same evidence — and the same honesty:
// static call-site order is not runtime order, so a call inside a callback
// or promise is counted in deferredCount and excluded from the emitted
// messages rather than sequenced by where the parser saw it.
//
// Participant resolution is case-insensitive declared-identifier matching: a
// callee with no declaring file in the scope is reported in unresolvedCallees,
// never attached to an invented participant (which class owns the method is a
// type question, and out of scope). Senders use the call-site file so duplicate
// caller names in other files cannot redirect their ownership.

import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_SEQUENCE_MESSAGES, MAX_SEQUENCE_PARTICIPANTS, toPosixPath } from "../../constants.js";
import type { DiagramType } from "../../types.js";
import { analyzeTsFile } from "../consistencyChecker/ts/tsIndex.js";
import { isTsFamilyExtension, loadTsModule } from "../consistencyChecker/ts/tsParse.js";
import type { TsModule } from "../consistencyChecker/ts/tsParse.js";
import {
  extractDeclaredIdentifiers,
  familyForExtension,
  stripCommentsAndStrings,
} from "../consistencyChecker/codeAnalysis.js";
import {
  mapWithConcurrency,
  MAX_SCAN_CONCURRENCY,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_FILES,
  SEQUENCE_SCAN_TRUNCATED_WARNING,
} from "../consistencyChecker/scanning.js";
import type { CallEdge } from "../consistencyChecker/sequence/callGraph.js";
import { extractCallEdges } from "../consistencyChecker/sequence/callGraph.js";
import { listScopeFiles } from "./scopeFiles.js";
import type {
  SequenceCalleeEvidence,
  SequenceCollectionResult,
  SequenceMessage,
  SequenceOptions,
} from "./types.js";
import { emitSequenceDiagram, mermaidParticipantName } from "./sequenceEmitters.js";

export type { SequenceCalleeEvidence, SequenceCollectionResult, SequenceMessage, SequenceOptions };

/**
 * Largest candidate list one callee_evidence entry reports. Candidates are
 * the declaring participants across the whole scanned scope, so the list is
 * cut at the same ceiling the participant cap uses and the exact count is
 * kept in candidates_available.
 */
export const MAX_SEQUENCE_EVIDENCE_CANDIDATES = MAX_SEQUENCE_PARTICIPANTS;

interface ScannedSequenceFile {
  /** Absolute path; only used for emission ordering. */
  absolutePath: string;
  /** Participant name for the file: its basename without extension. */
  moduleName: string;
  /** Declared identifiers, the operations this participant can receive. */
  operations: Set<string>;
  /** Call sites in source order. */
  edges: CallEdge[];
}

/** One participant and the operations it declares; merged on name clashes. */
interface ParticipantRegistryEntry {
  name: string;
  operations: Set<string>;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Empty result for a scope with no code files; fresh object per caller. */
function emptyResult(format: "puml" | "mermaid"): SequenceCollectionResult {
  const type: DiagramType = format === "puml" ? "plantuml" : "mermaid";
  return {
    participants: [],
    participantsAvailable: 0,
    participantsDropped: 0,
    messages: [],
    messagesAvailable: 0,
    messagesDropped: 0,
    deferredCount: 0,
    unresolvedCallees: [],
    ambiguousCallees: [],
    calleeEvidence: [],
    filesScanned: 0,
    truncated: false,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: null,
    tsAstAvailable: false,
    source: emitSequenceDiagram(type, [], []),
  };
}

/** Unreadable and oversized files are skipped; unexpected failures propagate. */
async function readSequenceFile(
  file: string,
  compiler: TsModule | null,
): Promise<ScannedSequenceFile | null> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    if (Buffer.byteLength(raw, "utf-8") > MAX_SCAN_FILE_BYTES) return null;
    const ext = path.extname(file).toLowerCase();
    const family = familyForExtension(ext);
    const stripped = stripCommentsAndStrings(raw, family);

    const operations = new Set<string>();
    // AST names first (they ignore import specifiers, so an imported
    // operation does not make this file look like its declarer); the
    // heuristic union fills shapes the visitor does not read.
    let astEdges: CallEdge[] | null = null;
    if (isTsFamilyExtension(ext)) {
      const analysis = await analyzeTsFile(raw, ext, file, { ts: compiler, includeCalls: true });
      for (const name of analysis.declared) operations.add(name);
      if (analysis.callGraph) {
        for (const name of analysis.callGraph.operations) operations.add(name);
        astEdges = analysis.callGraph.edges;
      }
    }
    for (const name of extractDeclaredIdentifiers(stripped, family)) operations.add(name);

    return {
      absolutePath: file,
      moduleName: path.basename(file, ext),
      operations,
      edges: astEdges ?? extractCallEdges(stripped),
    };
  } catch (err: unknown) {
    // Skip unreadable files; unexpected failures must surface instead of
    // silently shrinking the message list.
    const skippable =
      isNodeError(err) &&
      (err.code === "ENOENT" ||
        err.code === "EACCES" ||
        err.code === "EPERM" ||
        err.code === "ENOTDIR" ||
        err.code === "EISDIR");
    if (!skippable) throw err;
    return null;
  }
}

/**
 * Registry of participants a scope declares, in POSIX-path order of first
 * occurrence. Two files sharing a basename merge into one participant so a
 * call resolves to one name, not two.
 */
function buildParticipantRegistry(scanned: ScannedSequenceFile[]): ParticipantRegistryEntry[] {
  const registry: ParticipantRegistryEntry[] = [];
  const byName = new Map<string, ParticipantRegistryEntry>();
  for (const file of scanned) {
    const existing = byName.get(file.moduleName);
    if (existing) {
      for (const name of file.operations) existing.operations.add(name);
      continue;
    }
    const entry: ParticipantRegistryEntry = { name: file.moduleName, operations: file.operations };
    byName.set(entry.name, entry);
    registry.push(entry);
  }
  return registry;
}

interface IndexedOperation {
  firstParticipant: string;
  ambiguous: boolean;
  /** Every declaring participant in registry order; firstParticipant is [0]. */
  declarers: string[];
}

type OperationIndex = Map<string, IndexedOperation>;

// Build after merging same-basename files. An earlier folded match must keep
// precedence even when a later participant declares the exact-case name.
function buildOperationIndex(registry: ParticipantRegistryEntry[]): OperationIndex {
  const index: OperationIndex = new Map();
  for (const entry of registry) {
    const keys = new Set(Array.from(entry.operations, (name) => name.toLowerCase()));
    for (const key of keys) {
      const indexed = index.get(key);
      if (!indexed) {
        index.set(key, {
          firstParticipant: entry.name,
          ambiguous: false,
          declarers: [entry.name],
        });
      } else if (indexed.firstParticipant !== entry.name) {
        indexed.ambiguous = true;
        indexed.declarers.push(entry.name);
      }
    }
  }
  return index;
}

function resolveParticipant(index: OperationIndex, name: string): string | null {
  return index.get(name.toLowerCase())?.firstParticipant ?? null;
}

function collectAmbiguousCallees(
  messages: SequenceMessage[],
  operationIndex: OperationIndex,
): string[] {
  const ambiguousCallees: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (
      !operationIndex.get(message.message.toLowerCase())?.ambiguous ||
      seen.has(message.message)
    ) {
      continue;
    }
    seen.add(message.message);
    ambiguousCallees.push(message.message);
  }
  return ambiguousCallees;
}

/**
 * One entry per distinct emitted message spelling, in first emitted order
 * after both caps, explaining how the existing first-declaration rule picked
 * each receiver. Candidates come from the whole registry — after same-basename
 * merging and before the output participant cap — so a competing declarer
 * shows up even when the cap never emits it. Names are logical file
 * basenames, never the dialect-renamed identifiers the emitted lists carry.
 */
function collectCalleeEvidence(
  messages: SequenceMessage[],
  operationIndex: OperationIndex,
): SequenceCalleeEvidence[] {
  const evidence: SequenceCalleeEvidence[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.message)) continue;
    seen.add(message.message);
    // Only resolved messages reach this collector; missing index entries are not evidence.
    const indexed = operationIndex.get(message.message.toLowerCase())!;
    const declarers = indexed.declarers;
    evidence.push({
      callee: message.message,
      selected_participant: indexed.firstParticipant,
      candidate_participants: declarers.slice(0, MAX_SEQUENCE_EVIDENCE_CANDIDATES),
      candidates_available: declarers.length,
      candidates_capped: declarers.length > MAX_SEQUENCE_EVIDENCE_CANDIDATES,
      candidate_limit: MAX_SEQUENCE_EVIDENCE_CANDIDATES,
      resolution_basis: "case-insensitive-declaration",
    });
  }
  return evidence;
}

/** Distinct participant names in candidate order (a sender comes first). */
function candidateParticipants(candidates: SequenceMessage[]): string[] {
  const participants: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const name of [candidate.from, candidate.to]) {
      if (!seen.has(name)) {
        seen.add(name);
        participants.push(name);
      }
    }
  }
  return participants;
}

/**
 * Apply the dialect's participant naming to the emitted lists. PlantUML
 * quotes at render time, so its lists keep the logical names; Mermaid renames
 * to identifiers, so its lists must carry the renamed forms to agree with
 * the source.
 */
function applyDialectNames(
  format: "puml" | "mermaid",
  participants: string[],
  messages: SequenceMessage[],
): { participants: string[]; messages: SequenceMessage[] } {
  if (format === "puml") return { participants, messages };
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  for (const name of participants) {
    rename.set(name, mermaidParticipantName(name, taken));
  }
  return {
    participants: participants.map((name) => rename.get(name) as string),
    messages: messages.map((message) => ({
      ...message,
      from: rename.get(message.from) as string,
      to: rename.get(message.to) as string,
    })),
  };
}

function collectCandidateMessages(
  scanned: ScannedSequenceFile[],
  operationIndex: OperationIndex,
): { candidates: SequenceMessage[]; unresolvedCallees: string[]; deferredCount: number } {
  const candidates: SequenceMessage[] = [];
  const unresolvedCallees: string[] = [];
  const seenUnresolved = new Set<string>();
  let deferredCount = 0;

  for (const file of scanned) {
    for (const edge of file.edges) {
      // A deferred call is counted, never sequenced: its runtime order is
      // unknowable from source, so emitting it would invent an order.
      if (edge.viaCallback) {
        deferredCount += 1;
        continue;
      }
      const to = resolveParticipant(operationIndex, edge.callee);
      if (to === null) {
        if (!seenUnresolved.has(edge.callee)) {
          seenUnresolved.add(edge.callee);
          unresolvedCallees.push(edge.callee);
        }
        continue;
      }
      // A global caller lookup would misattribute calls when names collide.
      candidates.push({
        from: file.moduleName,
        to,
        message: edge.callee,
        line: edge.line,
        via_callback: false,
      });
    }
  }

  return { candidates, unresolvedCallees, deferredCount };
}

/**
 * Collect a sequence from a resolved scope. Unreadable files are skipped and
 * a missing compiler uses heuristic declarations. Unexpected failures propagate.
 */
export async function collectSequence(
  scopePath: string,
  options?: SequenceOptions,
): Promise<SequenceCollectionResult> {
  const format = options?.format ?? "puml";
  const maxParticipants = options?.maxParticipants ?? MAX_SEQUENCE_PARTICIPANTS;
  const maxMessages = options?.maxMessages ?? MAX_SEQUENCE_MESSAGES;
  const includeCallParentheses = options?.includeCallParentheses ?? false;

  const { files, truncated } = await listScopeFiles(scopePath);
  if (files.length === 0) return emptyResult(format);

  // Resolve the compiler once for the whole scan; null keeps the heuristic
  // union and records that the AST path was unavailable. Resolve the seam
  // before awaiting: a `??` on the promise itself would always look non-null.
  const resolveCompiler = options?.deps?.loadTsModule ?? loadTsModule;
  const compiler = await resolveCompiler();

  const scanned = (
    await mapWithConcurrency(files, MAX_SCAN_CONCURRENCY, (file) =>
      readSequenceFile(file, compiler),
    )
  ).filter((entry): entry is ScannedSequenceFile => entry !== null);

  // Deterministic order: POSIX path order, then source order within a file.
  scanned.sort((a, b) => toPosixPath(a.absolutePath).localeCompare(toPosixPath(b.absolutePath)));

  const registry = buildParticipantRegistry(scanned);
  const operationIndex = buildOperationIndex(registry);
  const { candidates, unresolvedCallees, deferredCount } = collectCandidateMessages(
    scanned,
    operationIndex,
  );

  // Participants are the parties to the sequenced conversation, in the order
  // they first send or receive; a file with no calls is not a participant.
  const available = candidateParticipants(candidates);
  const participants = available.slice(0, maxParticipants);
  const included = new Set(participants);

  // A sequence must never message an undeclared box, so messages to a
  // participant the cap removed are dropped before the message cap applies;
  // both drops count as messagesDropped.
  const emittable = candidates.filter(
    (candidate) => included.has(candidate.from) && included.has(candidate.to),
  );
  const messages = emittable.slice(0, maxMessages);
  const ambiguousCallees = collectAmbiguousCallees(messages, operationIndex);
  // Evidence reads the pre-dialect messages, so its names stay logical
  // basenames even when the Mermaid dialect renames the emitted lists.
  const calleeEvidence = collectCalleeEvidence(messages, operationIndex);

  const named = applyDialectNames(format, participants, messages);
  const type: DiagramType = format === "puml" ? "plantuml" : "mermaid";

  return {
    participants: named.participants,
    participantsAvailable: available.length,
    participantsDropped: available.length - participants.length,
    messages: named.messages,
    messagesAvailable: candidates.length,
    messagesDropped: candidates.length - messages.length,
    deferredCount,
    unresolvedCallees,
    ambiguousCallees,
    calleeEvidence,
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: truncated ? SEQUENCE_SCAN_TRUNCATED_WARNING : null,
    tsAstAvailable: compiler !== null,
    source: emitSequenceDiagram(type, named.participants, named.messages, includeCallParentheses),
  };
}
