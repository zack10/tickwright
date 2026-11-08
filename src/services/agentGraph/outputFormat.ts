import { parseFileActions } from "../../utils/codeWriter";

const parseJson = (raw: string): Record<string, unknown> => {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, "");
  const clean = candidate.endsWith("```")
    ? candidate.slice(0, -3).trimEnd()
    : candidate;
  try {
    const value: unknown = JSON.parse(clean);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * Returns why an implement reply cannot be applied, or undefined when it
 * holds at least one well-formed FILE block. parseAgentOutput keeps
 * "actions" only when it is a string, so a reply with the wrong shape would
 * otherwise apply nothing and fail later as an unexplained empty diff.
 */
export const fileActionsError = (
  raw: string,
  actionsText: string,
): string | undefined => {
  try {
    if (parseFileActions(actionsText).length > 0) return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const actions = parseJson(raw).actions;
  if (Array.isArray(actions))
    return 'The "actions" field must be one string of FILE blocks, not an array';
  if (actions !== undefined && typeof actions !== "string")
    return `The "actions" field must be one string of FILE blocks, not ${actions === null ? "null" : typeof actions}`;
  return "The reply contained no FILE blocks, so nothing was changed";
};
