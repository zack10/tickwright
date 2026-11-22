import { githubSourceControl } from "./githubApp";
import { SourceControlAdapter, SourceRepository } from "./types";

/** The source-control adapter for a repository. */
// shortcut: every repository is on GitHub; pick by a host field on Repository when Phase 5 adds a second host.
export const getSourceControl = (_repository: SourceRepository): SourceControlAdapter => githubSourceControl;
