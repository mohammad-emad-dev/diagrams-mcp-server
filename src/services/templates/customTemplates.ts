import { promises as fs, constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAX_CUSTOM_TEMPLATE_BYTES,
  MAX_CUSTOM_TEMPLATE_NAME_CHARS,
  MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS,
} from "../../constants.js";

export class CustomTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomTemplateError";
  }
}

const DialectSchema = z.object({ source: z.string().min(1), entity: z.string().min(1) }).strict();
const FileSchema = z
  .object({ puml: DialectSchema.optional(), mermaid: DialectSchema.optional() })
  .strict();

function templateFailure(name: string, detail: string): CustomTemplateError {
  return new CustomTemplateError(`Custom template '${name}' ${detail}.`);
}

function decodeTemplate(buffer: Buffer, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    if (error instanceof TypeError) throw templateFailure(name, "is not valid UTF-8");
    throw error;
  }
}

async function readBoundedTemplate(handle: FileHandle, name: string): Promise<string> {
  const buffer = Buffer.alloc(MAX_CUSTOM_TEMPLATE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > MAX_CUSTOM_TEMPLATE_BYTES)
    throw templateFailure(name, `exceeds the ${MAX_CUSTOM_TEMPLATE_BYTES}-byte limit`);
  return decodeTemplate(buffer.subarray(0, total), name);
}

async function readTemplate(projectRoot: string, name: string): Promise<string> {
  try {
    const directory = path.join(projectRoot, ".diagrams-templates");
    if (!(await fs.lstat(directory)).isDirectory())
      throw templateFailure(name, "directory must be a regular directory, not a symlink");
    const root = await fs.realpath(directory);
    const file = path.join(root, `${name}.json`);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink())
      throw templateFailure(name, "must be a regular file, not a symlink");
    if (path.dirname(await fs.realpath(file)) !== root)
      throw templateFailure(name, "escapes the template directory");
    const flags =
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    const handle = await fs.open(file, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw templateFailure(name, "changed while being opened");
      if (opened.size > MAX_CUSTOM_TEMPLATE_BYTES)
        throw templateFailure(name, `exceeds the ${MAX_CUSTOM_TEMPLATE_BYTES}-byte limit`);
      return await readBoundedTemplate(handle, name);
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ELOOP"].includes(String(error.code))
    ) {
      throw templateFailure(name, "could not be read from .diagrams-templates");
    }
    throw error;
  }
}

function expand(pattern: string, replacements: Record<string, string>, name: string): string {
  const chunks: string[] = [];
  let size = 0;
  let offset = 0;
  const append = (chunk: string): void => {
    size += chunk.length;
    if (size > MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS)
      throw templateFailure(
        name,
        `exceeds the ${MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS}-character expansion limit`,
      );
    chunks.push(chunk);
  };
  for (const match of pattern.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const literal = pattern.slice(offset, match.index);
    if (literal.includes("{{") || literal.includes("}}"))
      throw templateFailure(name, "contains a malformed placeholder");
    append(literal);
    const replacement = Object.hasOwn(replacements, match[1]) ? replacements[match[1]] : undefined;
    if (replacement === undefined)
      throw templateFailure(name, "contains an unsupported placeholder");
    append(replacement);
    offset = match.index + match[0].length;
  }
  const tail = pattern.slice(offset);
  if (tail.includes("{{") || tail.includes("}}"))
    throw templateFailure(name, "contains a malformed placeholder");
  append(tail);
  return chunks.join("");
}

export interface CustomTemplateRequest {
  projectRoot: string;
  name: string;
  format: "puml" | "mermaid";
  title: string | null;
  entities: string[];
}

export async function emitCustomTemplate(request: CustomTemplateRequest): Promise<string> {
  const { projectRoot, name, format, title, entities } = request;
  if (name.length > MAX_CUSTOM_TEMPLATE_NAME_CHARS || !/^[A-Za-z0-9_-]+$/.test(name))
    throw new CustomTemplateError(
      "Custom template name must contain only letters, digits, underscores or hyphens.",
    );
  const text = await readTemplate(projectRoot, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw templateFailure(name, "is not valid JSON");
    throw error;
  }
  const definition = FileSchema.safeParse(parsed);
  if (!definition.success)
    throw templateFailure(
      name,
      "must define only puml/mermaid objects with source and entity strings",
    );
  const dialect = definition.data[format];
  if (!dialect) throw templateFailure(name, `does not support '${format}'`);
  const lines: string[] = [];
  let length = 0;
  for (const entity of entities) {
    const line = expand(dialect.entity, { name: entity }, name);
    length += line.length + (lines.length > 0 ? 1 : 0);
    if (length > MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS)
      throw templateFailure(
        name,
        `exceeds the ${MAX_CUSTOM_TEMPLATE_OUTPUT_CHARS}-character expansion limit`,
      );
    lines.push(line);
  }
  return expand(dialect.source, { title: title ?? "", entities: lines.join("\n") }, name);
}
