import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface RepoContext {
  fileTree: string[];
  /** Check names from the repository's toolchain (e.g. test, lint, build). */
  checks: string[];
  /** The configured language label, if any; otherwise the agent reads the files. */
  language?: string;
  selectedFiles: string[];
  selectedFileContents: Array<{ path: string; content: string }>;
  summary: string;
  /** The summary without file contents, for agents that read files with tools. */
  overview: string;
}

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "__pycache__",
  "target",
  ".gradle",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);
const MAX_FILE_TREE_ENTRIES = 250;
const MAX_SELECTED_FILES = 12;
const MAX_FILE_BYTES = 20_000;
const MAX_CONTEXT_CHARS = 60_000;

const normalizeRelativePath = (value: string) => value.replaceAll("\\", "/");

const shouldSkipEntry = (entry: Dirent): boolean => {
  const isDotFile = entry.name.startsWith(".") && entry.name !== ".env.example";
  const isExcludedDir = entry.isDirectory() && EXCLUDED_DIRS.has(entry.name);
  return isDotFile || isExcludedDir;
};

const safeReadText = async (filePath: string, maxBytes = MAX_FILE_BYTES) => {
  const buffer = await fs.readFile(filePath);
  return buffer.subarray(0, maxBytes).toString("utf8");
};

const listFiles = async (root: string) => {
  const files: string[] = [];
  const visit = async (dir: string) => {
    if (files.length >= MAX_FILE_TREE_ENTRIES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILE_TREE_ENTRIES) break;
      if (shouldSkipEntry(entry)) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = normalizeRelativePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  await visit(root);
  return files.sort((a, b) => a.localeCompare(b));
};

const tokenize = (value: string) =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );

// Manifests of the common toolchains: they say what the project is.
const MANIFEST =
  /^(package\.json|composer\.json|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|gemfile|[^/]+\.(csproj|sln))$/;
// Any language's source is a candidate; only binaries and lockfiles are not.
const NOT_SOURCE =
  /\.(png|jpe?g|gif|ico|svg|webp|bmp|pdf|zip|gz|tgz|jar|war|class|so|dylib|dll|exe|bin|woff2?|ttf|eot|mp[34]|mov|lock)$|(^|\/)(package-lock\.json|composer\.lock|go\.sum)$/;

const scoreFile = (file: string, ticketTokens: Set<string>) => {
  const lower = file.toLowerCase();
  let score = 0;
  if (lower === "readme.md") score += 12;
  if (MANIFEST.test(lower)) score += 10;
  if (lower.includes("test") || lower.includes("spec")) score += 4;
  if (/^(src|app|lib|pkg|internal)\//.test(lower)) score += 3;
  for (const token of ticketTokens) {
    if (lower.includes(token)) score += 8;
  }
  return score;
};

const selectRelevantFiles = (files: string[], ticket: string) => {
  const ticketTokens = tokenize(ticket);
  const ranked = files
    .filter((file) => !NOT_SOURCE.test(file.toLowerCase()))
    .map((file) => ({ file, score: scoreFile(file, ticketTokens) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const selected = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_SELECTED_FILES)
    .map((entry) => entry.file);
  if (selected.length > 0) return selected;
  return files
    .filter((file) => file === "README.md" || MANIFEST.test(file.toLowerCase()))
    .slice(0, MAX_SELECTED_FILES);
};

const readSelectedFiles = async (root: string, files: string[]) => {
  const contents: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const fullPath = path.resolve(root, file);
    const relative = path.relative(root, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      contents.push({ path: file, content: await safeReadText(fullPath) });
    } catch {
      // Files can disappear during generated edits; skip unavailable context.
    }
  }
  return contents;
};

type CollectedContext = Omit<RepoContext, "summary" | "overview">;

const formatOverview = (context: CollectedContext) =>
  [
    `Repository file tree sample:\n${context.fileTree.join("\n")}`,
    ...(context.language ? [`Language: ${context.language}`] : []),
    `Checks: ${context.checks.join(", ") || "none available"}`,
    `Files that look relevant to the ticket: ${context.selectedFiles.join(", ") || "none found"}`,
  ].join("\n\n");

const formatSummary = (context: CollectedContext) => {
  const selected = context.selectedFileContents
    .map(
      // Not the "FILE:" output syntax, so models don't echo it back unfenced.
      (file) =>
        `--- ${file.path} ---\n${file.content.slice(0, MAX_FILE_BYTES)}\n--- end of ${file.path} ---`,
    )
    .join("\n\n");
  return [
    `Repository file tree sample:\n${context.fileTree.join("\n")}`,
    ...(context.language ? [`Language: ${context.language}`] : []),
    `Checks: ${context.checks.join(", ") || "none available"}`,
    `Selected files:\n${selected || "No selected files could be read."}`,
  ]
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
};

export const collectRepoContext = async (
  root: string,
  ticket: string,
  toolchain: { language?: string; checks: Record<string, unknown> },
) => {
  const fileTree = await listFiles(root);
  const checks = Object.keys(toolchain.checks);
  const selectedFiles = selectRelevantFiles(fileTree, ticket);
  const selectedFileContents = await readSelectedFiles(root, selectedFiles);
  const partial = {
    fileTree,
    checks,
    language: toolchain.language,
    selectedFiles,
    selectedFileContents,
  };
  return {
    ...partial,
    summary: formatSummary(partial),
    overview: formatOverview(partial),
  };
};
