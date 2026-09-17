// Sequence collection for diagrams_generate_sequence: turn the ordered
// caller->callee edges found in a codebase slice into a starter sequence
// diagram.
//
// Reuses the consistency checker's ordered call graph (extractCallEdges) and
// the generate tool's scan stack, so "what is a call" and "what is declared"
// mean the same thing here as in diagrams_check_consistency and
// diagrams_generate. This is the generative flip side of the same evidence —
// and the same honesty: static call-site order is not runtime order, so a
// call inside a callback or promise is counted in deferredCount and excluded
// from the emitted messages rather than sequenced by where the parser saw it.
//
// Participant resolution is declared-identifier equality only: a callee with
// no declaring file in the scope is reported in unresolvedCallees, never
// attached to an invented participant (which class owns the method is a
// type question, and out of scope).

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
import { mapParticipants } from "../consistencyChecker/sequence/participantMapping.js";
import { listScopeFiles } from "./scopeFiles.js";
import type { GenerateDeps } from "./collectEntities.js";
import { emitSequenceDiagram, mermaidParticipantName } from "./sequenceEmitters.js";

/** One ordered message in the generated sequence. */
export interface SequenceMessage {
  /** Participant sending the message (the file the call site lives in). */
  from: string;
  /** Participant receiving it (the file declaring the called operation). */
  to: string;
  /** Called operation name, as written at the call site. */
  message: string;
  /** 1-based line number of the call site. */
  line: number;
  /** Always false in output: deferred calls are excluded, never sequenced. */
  via_callback: boolean;
}

export interface SequenceCollectionResult {
  /** Participants in emission order, already capped and dialect-named. */
  participants: string[];
  /** Distinct participants in candidate messages, before the cap. */
  participantsAvailable: number;
  /** Participants dropped by the cap. */
  participantsDropped: number;
  /** Messages in source order, already capped. */
  messages: SequenceMessage[];
  /** Candidate messages before the caps, may exceed the emitted count. */
  messagesAvailable: number;
  /** Messages dropped by the participant cap or the message cap. */
  messagesDropped: number;
  /** Call sites inside a callback/promise: counted, never sequenced. */
  deferredCount: number;
  /** Callee names with no declaring participant in the scope. */
  unresolvedCallees: string[];
  filesScanned: number;
  truncated: boolean;
  scanLimit: number;
  scanWarning: string | null;
  /** True when the TypeScript AST backed this collection. */
  tsAstAvailable: boolean;
  /** Emitted source; identical to the tool's text block. */
  source: string;
}

export interface SequenceOptions {
  /** Output dialect; names are quoted (PlantUML) or sanitized (Mermaid). */
  format?: "puml" | "mermaid";
  /** Overrides for the emitted caps; tests use small values. */
  maxParticipants?: number;
  maxMessages?: number;
  /** Compiler override; see GenerateDeps. */
  deps?: GenerateDeps;
}

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
    filesScanned: 0,
    truncated: false,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: null,
    tsAstAvailable: false,
    source: emitSequenceDiagram(type, [], []),
  };
}

/** Read and analyze one file; null when unreadable, oversized, or unparseable. */
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
    if (isTsFamilyExtension(ext)) {
      const analysis = await analyzeTsFile(raw, ext, file, { ts: compiler });
      for (const name of analysis.declared) operations.add(name);
    }
    for (const name of extractDeclaredIdentifiers(stripped, family)) operations.add(name);

    return {
      absolutePath: file,
      moduleName: path.basename(file, ext),
      operations,
      edges: extractCallEdges(stripped),
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

/** First participant declaring `name`, by declared-identifier equality; else null. */
function resolveParticipant(registry: ParticipantRegistryEntry[], name: string): string | null {
  for (const entry of registry) {
    if (mapParticipants([name], entry.operations)[0]?.mapsTo !== null) return entry.name;
  }
  return null;
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

/**
 * Collect a sequence from a resolved scope. Never throws: unreadable files
 * and a missing compiler both degrade to fewer messages, and every cap
 * reports itself in-band.
 */
export async function collectSequence(
  scopePath: string,
  options?: SequenceOptions,
): Promise<SequenceCollectionResult> {
  const format = options?.format ?? "puml";
  const maxParticipants = options?.maxParticipants ?? MAX_SEQUENCE_PARTICIPANTS;
  const maxMessages = options?.maxMessages ?? MAX_SEQUENCE_MESSAGES;

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
      const to = resolveParticipant(registry, edge.callee);
      if (to === null) {
        if (!seenUnresolved.has(edge.callee)) {
          seenUnresolved.add(edge.callee);
          unresolvedCallees.push(edge.callee);
        }
        continue;
      }
      // The call site physically lives in this file; the caller resolves
      // through the same index when it declares the enclosing operation.
      const from = resolveParticipant(registry, edge.caller) ?? file.moduleName;
      candidates.push({
        from,
        to,
        message: edge.callee,
        line: edge.line,
        via_callback: false,
      });
    }
  }

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
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_SCAN_FILES,
    scanWarning: truncated ? SEQUENCE_SCAN_TRUNCATED_WARNING : null,
    tsAstAvailable: compiler !== null,
    source: emitSequenceDiagram(type, named.participants, named.messages),
  };
}
