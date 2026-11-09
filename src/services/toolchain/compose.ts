import path from "node:path";
import yaml from "js-yaml";
import type { ServiceContainer } from "./types";

/**
 * A devcontainer that uses Docker Compose (https://containers.dev): its
 * `service` is the container the work runs in (built by the Dev Container
 * CLI), and the other services become the run's service containers, on its
 * private network. Only what can be used as-is is taken; everything else is
 * reported. Nothing here starts Compose itself.
 */

type Read = (file: string) => string | undefined;
type Spec = Record<string, unknown>;

/** A path relative to `from`'s folder as a repository path, or undefined if it leaves the repository. */
export const repoPath = (from: string, relative: string) => {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), relative.replaceAll("\\", "/")));
  return path.posix.isAbsolute(relative) || resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
};

/**
 * Compose fills `${NAME:-default}` from the environment, which a run never
 * gives it, so only the default is used; `$$` is a literal `$`. Any other
 * variable leaves the value unresolved (undefined).
 */
export const interpolate = (value: string): string | undefined => {
  let unresolved = false;
  const result = value.replace(/\$\$|\$\{([^}]*)\}|\$[A-Za-z_][A-Za-z0-9_]*/g, (match, braced: string | undefined) => {
    if (match === "$$") return "$";
    const withDefault = braced !== undefined ? /^[A-Za-z_][A-Za-z0-9_]*:?-(.*)$/s.exec(braced) : null;
    if (withDefault) return withDefault[1];
    unresolved = true;
    return match;
  });
  return unresolved ? undefined : result;
};

const environment = (service: string, raw: unknown, notes: string[]) => {
  const env: Record<string, string> = {};
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((entry) => {
        const text = String(entry);
        const at = text.indexOf("=");
        return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
      })
    : Object.entries((raw as Spec) ?? {});
  for (const [name, value] of entries) {
    const text = typeof value === "string" ? interpolate(value) : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
    if (text === undefined) notes.push(`Compose service ${service} environment ${name} was not applied`);
    else env[name] = text;
  }
  return env;
};

/** A healthcheck `test` as a command run inside the service until it succeeds. */
const readyCommand = (test: unknown): string[] | undefined => {
  if (typeof test === "string") return ["sh", "-c", test];
  if (!Array.isArray(test) || !test.every((part) => typeof part === "string")) return undefined;
  if (test[0] === "CMD" && test.length > 1) return test.slice(1);
  if (test[0] === "CMD-SHELL" && test.length === 2) return ["sh", "-c", test[1]];
  return undefined;
};

export interface ComposeEnvironment {
  /** Compose files and the main service's build inputs. */
  inputs: string[];
  /** The main service's environment. */
  env: Record<string, string>;
  /** The other services, unvalidated (the toolchain validates them). */
  services: ServiceContainer[];
}

/** Returns the environment, or a reason it cannot be built safely. */
export const readCompose = (
  devcontainerFile: string,
  spec: Spec,
  read: Read,
  notes: string[],
): ComposeEnvironment | { refused: string } => {
  const files = ([] as unknown[]).concat(spec.dockerComposeFile);
  const inputs: string[] = [];
  // shortcut: services are merged field by field, not deeply as Compose merges nested maps; enough for override files that set image, build or environment.
  const services: Record<string, Spec> = {};
  for (const file of files) {
    const composeFile = typeof file === "string" ? repoPath(devcontainerFile, file) : undefined;
    if (!composeFile) return { refused: `Compose file ${String(file)} is outside the repository` };
    const text = read(composeFile);
    if (text === undefined) return { refused: `Compose file ${composeFile} was not found` };
    let parsed: Spec;
    try {
      parsed = (yaml.load(text) as Spec) ?? {};
    } catch (error) {
      return { refused: `Compose file ${composeFile} could not be parsed (${(error as Error).message.split("\n")[0]})` };
    }
    // Both can read files outside the repository.
    if (parsed.include) return { refused: `Compose file ${composeFile} uses include, which is not supported` };
    inputs.push(composeFile);
    for (const [name, service] of Object.entries((parsed.services as Spec) ?? {}))
      services[name] = { ...(services[name] ?? {}), ...((service as Spec) ?? {}), file: composeFile };
  }

  // Compose reads these on the host for every service, even ones it does not build.
  for (const [name, service] of Object.entries(services)) {
    const extendsFile = service.extends && typeof service.extends === "object" ? (service.extends as Spec).file : undefined;
    const hostFiles = [
      ...([] as unknown[]).concat(service.env_file ?? []).map((entry) => (entry && typeof entry === "object" ? (entry as Spec).path : entry)),
      ...(extendsFile !== undefined ? [extendsFile] : []),
    ];
    for (const file of hostFiles)
      if (typeof file !== "string" || !repoPath(service.file as string, file))
        return { refused: `Compose service ${name} reads ${String(file)}, outside the repository` };
  }

  const mainName = spec.service;
  const main = typeof mainName === "string" ? services[mainName] : undefined;
  if (!main) return { refused: `the Compose service "${String(mainName)}" is not defined` };
  if (main.extends) return { refused: `Compose service ${mainName} uses extends, which is not supported` };
  if (main.build !== undefined) {
    const build = (typeof main.build === "string" ? { context: main.build } : main.build) as Spec;
    // These hand the build files or keys from the host.
    for (const key of ["secrets", "ssh", "additional_contexts", "cache_from", "cache_to"])
      if (build[key]) return { refused: `Compose service ${mainName} build.${key} is not supported` };
    const contextText = interpolate(typeof build.context === "string" ? build.context : ".");
    const context = contextText !== undefined ? repoPath(main.file as string, contextText) : undefined;
    const dockerfileText = interpolate(typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile");
    const dockerfile = context !== undefined && dockerfileText !== undefined ? repoPath(`${context}/x`, dockerfileText) : undefined;
    if (!context || !dockerfile) return { refused: `Compose service ${mainName} builds from outside the repository` };
    inputs.push(context, dockerfile);
  } else if (typeof main.image !== "string") return { refused: `Compose service ${mainName} has no image or build` };

  const run = Array.isArray(spec.runServices) ? new Set(spec.runServices.map(String)) : undefined;
  const others: ServiceContainer[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (name === mainName || (run && !run.has(name))) continue;
    const image = typeof service.image === "string" ? interpolate(service.image) : undefined;
    if (service.build !== undefined || service.extends || !image) {
      notes.push(`Compose service ${name} was not started: only services with a plain image are`);
      continue;
    }
    if (service.env_file) notes.push(`Compose service ${name} env_file was not applied`);
    const healthcheck = (service.healthcheck as Spec) ?? {};
    const ready = healthcheck.disable ? undefined : readyCommand(healthcheck.test);
    if (healthcheck.test && !ready && !healthcheck.disable) notes.push(`Compose service ${name} healthcheck was not applied`);
    const env = environment(name, service.environment, notes);
    others.push({ name, image, ...(Object.keys(env).length ? { env } : {}), ...(ready ? { ready } : {}) });
  }
  if (main.env_file) notes.push(`Compose service ${mainName} env_file was not applied`);
  return { inputs, env: environment(String(mainName), main.environment, notes), services: others };
};
