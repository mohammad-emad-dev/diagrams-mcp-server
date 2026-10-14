import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { MAX_CUSTOM_TEMPLATE_NAME_CHARS, MAX_TEMPLATE_SCAN_ENTRIES } from "../../constants.js";
import { CustomTemplateError, resolveCustomTemplateDirectory } from "./customTemplates.js";

interface TemplateCatalog {
  names: string[];
  entriesScanned: number;
  truncated: boolean;
}

function candidateName(entry: Dirent): string | null {
  if (!entry.isFile() || !entry.name.endsWith(".json")) return null;
  const name = entry.name.slice(0, -5);
  return name.length > 0 &&
    name.length <= MAX_CUSTOM_TEMPLATE_NAME_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(name)
    ? name
    : null;
}

async function scanDirectory(directory: string): Promise<TemplateCatalog> {
  const names: string[] = [];
  let entriesScanned = 0;
  let truncated = false;
  for await (const entry of await fs.opendir(directory)) {
    if (entriesScanned === MAX_TEMPLATE_SCAN_ENTRIES) {
      truncated = true;
      break;
    }
    entriesScanned++;
    const name = candidateName(entry);
    if (name !== null) names.push(name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { names, entriesScanned, truncated };
}

export async function listCustomTemplates(projectRoot: string): Promise<TemplateCatalog> {
  try {
    return await scanDirectory(await resolveCustomTemplateDirectory(projectRoot));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return { names: [], entriesScanned: 0, truncated: false };
      if (
        ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EINVAL", "ENAMETOOLONG"].includes(
          String(error.code),
        )
      ) {
        throw new CustomTemplateError("Custom template directory could not be read.");
      }
    }
    throw error;
  }
}
