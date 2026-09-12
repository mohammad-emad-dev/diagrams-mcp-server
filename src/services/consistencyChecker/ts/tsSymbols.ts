// AST symbol collection as a pure visitor (no filesystem, no matching).
//
// Collects declaration names only: classes, interfaces, enums, type
// aliases, functions, variables, export-specifier sides
// (`export { A as B }` records both), default-exported identifiers, and
// namespace segments. Property names, import specifiers, and
// `export *` barrels are deliberately ignored (see tsGoldens barrel lock).

import { loadTsModule } from "./tsParse.js";
import type { TsModule } from "./tsParse.js";
import type * as tsTypes from "typescript";

/** Add a bare identifier; qualified/dotted names are split by the caller. */
function addIdentifier(target: Set<string>, name: string): void {
  if (/^[A-Za-z_$][\w$]*$/.test(name)) target.add(name);
}

/** Namespace name text; "" when quoted. Nested namespaces resolve by recursion. */
function moduleNameText(ts: TsModule, name: tsTypes.ModuleName): string {
  if (ts.isIdentifier(name)) return name.text;
  return "";
}

function visitNode(ts: TsModule, node: tsTypes.Node, declared: Set<string>): void {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    if (node.name && ts.isIdentifier(node.name)) addIdentifier(declared, node.name.text);
  } else if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) addIdentifier(declared, declaration.name.text);
    }
  } else if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (ts.isIdentifier(element.name)) addIdentifier(declared, element.name.text);
        if (element.propertyName && ts.isIdentifier(element.propertyName)) {
          addIdentifier(declared, element.propertyName.text);
        }
      }
    }
  } else if (ts.isExportAssignment(node)) {
    if (ts.isIdentifier(node.expression)) addIdentifier(declared, node.expression.text);
  } else if (ts.isModuleDeclaration(node)) {
    const full = moduleNameText(ts, node.name);
    for (const part of full.split(".")) addIdentifier(declared, part);
  }
  ts.forEachChild(node, (child) => visitNode(ts, child, declared));
}

/** Collect declared symbol names from a parsed source file. */
export async function collectTsDeclaredSymbols(sourceFile: unknown): Promise<Set<string>> {
  const declared = new Set<string>();
  if (!sourceFile || typeof sourceFile !== "object") return declared;
  const ts = await loadTsModule();
  if (!ts) return declared;
  const root = sourceFile as tsTypes.SourceFile;
  if (root.kind !== ts.SyntaxKind.SourceFile || !Array.isArray(root.statements)) {
    return declared;
  }
  visitNode(ts, root, declared);
  return declared;
}
