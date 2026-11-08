/**
 * Reads the project's own environment definition (the Dev Container spec,
 * https://containers.dev): the image it names, its environment and its
 * lifecycle commands as the setup step. Only what can be used as-is is
 * taken; everything else is reported, never guessed.
 */

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

export interface DevcontainerEnvironment {
  file: string;
  image?: string;
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
  if (!image && (spec.build || spec.dockerFile)) notes.push(`${file} builds a Dockerfile, which is not supported yet`);
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
    setup: commands.length ? ["sh", "-c", commands.join(" && ")] : null,
    env,
    notes,
  };
};
