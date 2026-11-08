/**
 * Reads the project's own environment definition (the Dev Container spec,
 * https://containers.dev): the image it names, its environment and its
 * lifecycle commands as the setup step. Only what can be used as-is is
 * taken; everything else is reported, never guessed.
 */

import path from "node:path";
import type { DockerBuild } from "./types";

export const DEVCONTAINER_FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"];

/**
 * Copies `text`, passing each character outside string literals to
 * `outside`, which returns what to emit and how many characters it used.
 */
const scan = (text: string, outside: (at: number) => [string, number]) => {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, ++i);
    } else {
      const [emit, used] = outside(i);
      out += emit;
      i += used;
    }
  }
  return out;
};

/** devcontainer.json is JSON with comments and trailing commas. */
export const parseJsonc = (text: string): unknown => {
  const noComments = scan(text, (i) => {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      return ["", (end === -1 ? text.length : end) - i];
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      return [" ", (end === -1 ? text.length : end + 2) - i];
    }
    return [text[i], 1];
  });
  const json = scan(noComments, (i) =>
    noComments[i] === "," && /^\s*[}\]]/.test(noComments.slice(i + 1)) ? ["", 1] : [noComments[i], 1],
  );
  return JSON.parse(json);
};

const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

/** A lifecycle command is a string (shell), an array (argv) or an object of either. */
const toShell = (command: unknown): string[] => {
  if (typeof command === "string") return command.trim() ? [command] : [];
  if (Array.isArray(command) && command.every((arg) => typeof arg === "string"))
    return command.length ? [command.map(shellQuote).join(" ")] : [];
  if (command && typeof command === "object") return Object.values(command).flatMap(toShell);
  return [];
};

// Run in the order a dev container runs them when it is created.
const LIFECYCLE = ["onCreateCommand", "updateContentCommand", "postCreateCommand"];
// Values like ${containerEnv:PATH} need a running dev container to resolve.
const hasVariable = (value: string) => value.includes("${");

/** A path from devcontainer.json (relative to its folder) as a repository path, or undefined if it leaves the repository. */
const repoPath = (file: string, relative: string) => {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative.replaceAll("\\", "/")));
  return path.posix.isAbsolute(relative) || resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
};

/** `build` (or the older top-level `dockerFile`/`context`): built as-is, before setup. */
const readBuild = (file: string, spec: Record<string, unknown>, notes: string[]): DockerBuild | undefined => {
  const build = (spec.build && typeof spec.build === "object" ? spec.build : spec) as Record<string, unknown>;
  const dockerfileField = build === spec ? spec.dockerFile : build.dockerfile;
  if (typeof dockerfileField !== "string") {
    if (spec.build) notes.push(`${file} build names no dockerfile`);
    return undefined;
  }
  const dockerfile = repoPath(file, dockerfileField);
  const context = repoPath(file, typeof build.context === "string" ? build.context : ".");
  if (!dockerfile || !context) {
    notes.push(`${file} build points outside the repository, so it was not built`);
    return undefined;
  }
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries((build.args as Record<string, unknown>) ?? {})) {
    if (typeof value !== "string" || hasVariable(value)) notes.push(`build.args.${name} was not applied`);
    else args[name] = value;
  }
  for (const key of ["options", "cacheFrom"]) if (build[key]) notes.push(`build.${key} was not applied`);
  return { dockerfile, context, args, ...(typeof build.target === "string" ? { target: build.target } : {}) };
};

export interface DevcontainerEnvironment {
  file: string;
  image?: string;
  build?: DockerBuild;
  setup: string[] | null;
  env: Record<string, string>;
  notes: string[];
}

export const readDevcontainer = (read: (file: string) => string | undefined): DevcontainerEnvironment | undefined => {
  const file = DEVCONTAINER_FILES.find((candidate) => read(candidate) !== undefined);
  if (!file) return undefined;
  const notes: string[] = [];
  let spec: Record<string, unknown>;
  try {
    spec = parseJsonc(read(file)!) as Record<string, unknown>;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("not an object");
  } catch (error) {
    return { file, setup: null, env: {}, notes: [`${file} could not be parsed (${(error as Error).message})`] };
  }

  const image = typeof spec.image === "string" ? spec.image : undefined;
  const build = image ? undefined : readBuild(file, spec, notes);
  if (spec.dockerComposeFile) notes.push(`${file} uses Docker Compose, which is not supported yet`);
  if (spec.features && Object.keys(spec.features as object).length)
    notes.push(`${file} features were not applied: ${Object.keys(spec.features as object).join(", ")}`);

  const env: Record<string, string> = {};
  for (const key of ["containerEnv", "remoteEnv"])
    for (const [name, value] of Object.entries((spec[key] as Record<string, unknown>) ?? {})) {
      if (typeof value !== "string" || hasVariable(value)) notes.push(`${key}.${name} was not applied`);
      else env[name] = value;
    }

  const commands = LIFECYCLE.flatMap((key) => toShell(spec[key]));
  return {
    file,
    image,
    ...(build ? { build } : {}),
    setup: commands.length ? ["sh", "-c", commands.join(" && ")] : null,
    env,
    notes,
  };
};
