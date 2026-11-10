import fs from "node:fs";
import path from "node:path";

/**
 * Prompt versions the execution graph uses. A wording change is a new file
 * (e.g. implement.v2.md) plus a bump here, so every benchmark result can be
 * tied to the exact prompts that produced it. Never edit a released version.
 */
export const EXECUTION_PROMPTS = {
  triage: "triage.v1",
  plan: "plan.v5",
  planner: "planner.v2",
  implement: "implement.v2",
  agent: "agent.v6",
  analyze: "analyze.v2",
  review: "review.v6",
  reviewer: "reviewer.v6",
  discover: "discover.v3",
  fileFormat: "file-format.v1",
} as const;

export type ExecutionPromptName = keyof typeof EXECUTION_PROMPTS;

export interface RenderedPrompt {
  version: string;
  system: string;
  user: string;
}

const PROMPT_DIR = path.join(__dirname, "execution");
const VERSION_PATTERN = /^[a-z][a-z0-9-]*\.v\d+$/;
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;
const SECTION_PATTERN = /^<!-- (system|user) -->$/m;

const cache = new Map<string, string>();

const readPromptFile = (version: string) => {
  if (!VERSION_PATTERN.test(version))
    throw new Error(`Invalid prompt version "${version}"`);
  let text = cache.get(version);
  if (text === undefined) {
    text = fs
      .readFileSync(path.join(PROMPT_DIR, `${version}.md`), "utf8")
      .replace(/\r\n/g, "\n");
    cache.set(version, text);
  }
  return text;
};

/**
 * Single pass, so a value that itself contains "{{name}}" (e.g. ticket text)
 * is inserted as-is. Missing and unused variables both fail loudly: either
 * one means the template and the code calling it disagree.
 */
const fill = (
  version: string,
  templates: string[],
  variables: Record<string, string>,
) => {
  const used = new Set<string>();
  const results = templates.map((template) =>
    template.replace(VARIABLE_PATTERN, (_match, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, name))
        throw new Error(`Prompt ${version} is missing variable "${name}"`);
      used.add(name);
      return variables[name];
    }),
  );
  const unused = Object.keys(variables).filter((name) => !used.has(name));
  if (unused.length)
    throw new Error(
      `Prompt ${version} does not use variable(s): ${unused.join(", ")}`,
    );
  return results;
};

/** A prompt file holds a `<!-- system -->` and a `<!-- user -->` section. */
export const renderPromptVersion = (
  version: string,
  variables: Record<string, string> = {},
): RenderedPrompt => {
  const sections: Record<string, string> = {};
  const parts = readPromptFile(version).split(SECTION_PATTERN);
  for (let index = 1; index < parts.length; index += 2)
    sections[parts[index]] = parts[index + 1].trim();
  if (sections.system === undefined || sections.user === undefined)
    throw new Error(`Prompt ${version} needs a system and a user section`);

  const [system, user] = fill(
    version,
    [sections.system, sections.user],
    variables,
  );
  return { version, system, user };
};

/** A fragment is plain text without sections, shared between prompts. */
export const promptFragment = (version: string) =>
  fill(version, [readPromptFile(version).trim()], {})[0];

export const renderExecutionPrompt = (
  name: Exclude<ExecutionPromptName, "fileFormat">,
  variables: Record<string, string>,
) => renderPromptVersion(EXECUTION_PROMPTS[name], variables);

export const executionPromptFragment = (name: "fileFormat") =>
  promptFragment(EXECUTION_PROMPTS[name]);
