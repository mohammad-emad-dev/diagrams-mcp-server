import type { DiagramType } from "../../types.js";
import {
  MAX_SCAFFOLD_MEMBERS_PER_CLASS,
  isScaffoldMemberName,
  type ScaffoldMember,
} from "./members.js";
import { topLevelScaffoldLines } from "./diagramLines.js";

export const MAX_SCAFFOLD_RELATIONS = 300;

const PLAIN_CLASS_DECL = /^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\{\s*\}?)?$/;
const SCAFFOLD_ASSOCIATION =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*-->\s*(?:"(\*|0\.\.\*|1\.\.\*)"\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)$/;

export interface ScaffoldRelationsConfig {
  source: string;
  type: DiagramType;
  entities: readonly string[];
  membersByClass: ReadonlyMap<string, ScaffoldMember[]>;
}

export interface ScaffoldRelationsResult {
  membersByClass: Map<string, ScaffoldMember[]>;
  relationsIncluded: number;
  relationsSkipped: number;
  relationsCapped: boolean;
  membersCapped: boolean;
}

function parseScaffoldAssociation(
  line: string,
): { owner: string; target: string; role: string; isMany: boolean } | undefined {
  const match = SCAFFOLD_ASSOCIATION.exec(line);
  if (!match) return undefined;
  const [, owner, multiplicity, target, role] = match;
  return { owner, target, role, isMany: multiplicity !== undefined };
}

function collectDeclaredScaffoldClasses(
  source: string,
  type: DiagramType,
  emitted: ReadonlySet<string>,
): Set<string> {
  const declared = new Set<string>();
  for (const line of topLevelScaffoldLines(source, type)) {
    const name = PLAIN_CLASS_DECL.exec(line)?.[1];
    if (name !== undefined && emitted.has(name)) declared.add(name);
    if (declared.size >= emitted.size) break;
  }
  return declared;
}

function copyScaffoldMembers(
  entities: readonly string[],
  membersByClass: ReadonlyMap<string, ScaffoldMember[]>,
): Map<string, ScaffoldMember[]> {
  const copy = new Map<string, ScaffoldMember[]>();
  for (const name of entities) copy.set(name, [...(membersByClass.get(name) ?? [])]);
  return copy;
}

function eligibleRelationMembers(
  association: { owner: string; target: string; role: string },
  declared: ReadonlySet<string>,
  membersByClass: ReadonlyMap<string, ScaffoldMember[]>,
): ScaffoldMember[] | undefined {
  const { owner, target, role } = association;
  if (!declared.has(owner) || !declared.has(target) || !isScaffoldMemberName(role))
    return undefined;
  const members = membersByClass.get(owner);
  return members?.some((existing) => existing.name === role) ? undefined : members;
}

export function appendScaffoldRelations(config: ScaffoldRelationsConfig): ScaffoldRelationsResult {
  const emitted = new Set(config.entities);
  const declared = collectDeclaredScaffoldClasses(config.source, config.type, emitted);
  const membersByClass = copyScaffoldMembers(config.entities, config.membersByClass);
  let relationsIncluded = 0;
  let relationsSkipped = 0;
  let relationsCapped = false;
  let membersCapped = false;
  for (const line of topLevelScaffoldLines(config.source, config.type)) {
    const association = parseScaffoldAssociation(line);
    if (!association) continue;
    const { target, role, isMany } = association;
    const current = eligibleRelationMembers(association, declared, membersByClass);
    if (!current) {
      relationsSkipped += 1;
      continue;
    }
    if (current.length >= MAX_SCAFFOLD_MEMBERS_PER_CLASS) {
      relationsSkipped += 1;
      relationsCapped = true;
      membersCapped = true;
      continue;
    }
    if (relationsIncluded >= MAX_SCAFFOLD_RELATIONS) {
      relationsSkipped += 1;
      relationsCapped = true;
      continue;
    }
    current.push({ kind: "field", name: role, typeLabel: isMany ? `${target}[]` : target });
    relationsIncluded += 1;
  }
  return { membersByClass, relationsIncluded, relationsSkipped, relationsCapped, membersCapped };
}
