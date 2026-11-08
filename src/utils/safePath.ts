import fs from "node:fs";
import path from "node:path";

/** True when any path segment is `.git` (hooks and config live there). */
export const isGitPath = (relativePath: string) =>
  relativePath
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === ".git");

/**
 * The first symlink between `root` and `relativePath`, if any. Links
 * committed to a repository could otherwise redirect a read or write to any
 * file on the host.
 */
export const findSymlink = (
  root: string,
  relativePath: string,
): string | undefined => {
  let current = root;
  for (const segment of relativePath.split(/[\\/]/)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return undefined; // Nothing exists below this point yet.
    }
    if (stat.isSymbolicLink()) return current;
  }
  return undefined;
};

/**
 * Resolves `filePath` inside `root`, or returns undefined when it is empty,
 * absolute, contains a NUL byte or escapes the root. `relativePath` uses
 * forward slashes.
 */
export const resolveInsideRoot = (
  root: string,
  filePath: string,
): { fullPath: string; relativePath: string } | undefined => {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0"))
    return undefined;
  const fullPath = path.resolve(root, filePath);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { fullPath, relativePath: relative.replaceAll("\\", "/") };
};
