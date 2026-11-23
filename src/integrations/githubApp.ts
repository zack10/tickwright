import axios from "axios";
import crypto from "node:crypto";

import { z } from "zod";

import { config } from "../config";
import { NonRetryableError, describeError } from "../utils/safeError";
import { CommitChecks, ReviewFeedback, PullRequestOutcome, SourceControlAdapter, SourceControlTarget } from "./types";

const base64url = (value: string) => Buffer.from(value).toString("base64url");
const appJwt = () => {
  const appId = config.githubAppId;
  const privateKey = config.githubAppPrivateKey.replaceAll(
    String.raw`\n`,
    "\n",
  );
  if (!appId || !privateKey)
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  return `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
};

export const getInstallationToken = async (installationId: string) => {
  const response = await axios.post<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {},
    {
      headers: {
        Authorization: `Bearer ${appJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 15000,
    },
  );
  return response.data.token;
};

export const getBaseSha = async (
  installationId: string,
  owner: string,
  repo: string,
  branch: string,
) => {
  const token = await getInstallationToken(installationId);
  const response = await axios.get<{ object: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 15000,
    },
  );
  return response.data.object.sha;
};

export const findOpenPullRequest = async (input: {
  installationId: string;
  owner: string;
  repo: string;
  head: string;
}) => {
  const token = await getInstallationToken(input.installationId);
  const response = await axios.get<Array<{ number: number; html_url: string }>>(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
    {
      params: { head: `${input.owner}:${input.head}`, state: "open" },
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 15000,
    },
  );
  return response.data[0];
};

export const createDraftPullRequest = async (input: {
  installationId: string;
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
}) => {
  const token = await getInstallationToken(input.installationId);
  const response = await axios.post(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
    {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: true,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 15000,
    },
  );
  return response.data as { number: number; html_url: string };
};

export const getPullRequestOutcome = async (installationId: string, owner: string, repo: string, number: number): Promise<PullRequestOutcome> => {
  const token = await getInstallationToken(installationId);
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const { data } = await axios.get<{ state: "open" | "closed"; merged_at: string | null; closed_at: string | null }>(url, { headers, timeout: 15000 });
  if (data.state === "open") return { state: "OPEN" };
  const closedAt = new Date(data.merged_at ?? data.closed_at ?? Date.now());
  if (!data.merged_at) return { state: "CLOSED", closedAt };
  try {
    const diff = await axios.get<string>(url, {
      headers: { ...headers, Accept: "application/vnd.github.diff" },
      responseType: "text",
      timeout: 30000,
    });
    return { state: "MERGED", closedAt, diff: diff.data };
  } catch (error) {
    // GitHub answers 406 when a diff is too large to render; the outcome is still worth keeping.
    if (axios.isAxiosError(error) && error.response?.status === 406) return { state: "MERGED", closedAt };
    throw error;
  }
};

export const commentOnPullRequest = async (installationId: string, owner: string, repo: string, number: number, body: string) => {
  const token = await getInstallationToken(installationId);
  // A pull request's conversation is its issue's comments.
  await axios.post(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, { body }, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    timeout: 15000,
  });
};

interface GithubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  html_url: string | null;
  app: { slug: string } | null;
  output: { title: string | null; summary: string | null; text: string | null } | null;
}

const FAILED_CONCLUSIONS = ["failure", "timed_out"];
const MAX_CHECK_OUTPUT = 3000;
// shortcut: reads 10 failed checks of a commit; a commit failing more is one problem spread wide, read more if that ever matters.
const MAX_FAILED_CHECKS = 10;

// The words test tools and compilers of many stacks print, in capitals, where something failed.
const FAILURE_LINE = /\b(ERROR|FAIL|FAILED|FAILURE|FATAL)\b/;

/**
 * Where an Actions job failed: the step that ended in the last "##[error]"
 * line, since the end of a log is the cleanup steps; without one, the end.
 * A long step keeps the part from its first line reporting a failure, and
 * its end (the summary): the start of a step is build output and the middle
 * stack traces (PR #10 of dynamic-csv-batch-processor: the failing test sat
 * in the middle of a 27,000-character step). Timestamps and colour codes are
 * dropped to keep the excerpt short.
 */
export const failureExcerpt = (log: string, max = MAX_CHECK_OUTPUT) => {
  const lines = log
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  const lastError = lines.map((line) => line.startsWith("##[error]")).lastIndexOf(true);
  // The end matters most when there is no error line to anchor the step.
  if (lastError < 0) return lines.join("\n").trimEnd().slice(-max);
  const stepStart = Math.max(0, lines.slice(0, lastError).map((line) => line.startsWith("##[group]Run ")).lastIndexOf(true));
  const step = lines.slice(stepStart, lastError + 1);
  const failure = step.findIndex((line, index) => index > 0 && !line.startsWith("##[") && FAILURE_LINE.test(line));
  // The step's command line, then from a few lines before its first failure.
  const from = failure > 0 ? Math.max(1, failure - 3) : 1;
  const focus = [step[0], ...(from > 1 ? ["[...]"] : []), ...step.slice(from)].join("\n").trimEnd();
  if (focus.length <= max) return focus;
  const half = Math.floor(max / 2);
  return `${focus.slice(0, half)}\n[${focus.length - 2 * half} characters cut]\n${focus.slice(-half)}`;
};

export const getCommitChecks = async (installationId: string, owner: string, repo: string, sha: string): Promise<CommitChecks> => {
  const token = await getInstallationToken(installationId);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  // shortcut: reads the first 100 check runs and no legacy commit statuses; page and add /status if a repository relies on them.
  const { data } = await axios.get<{ check_runs: GithubCheckRun[] }>(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`, {
    headers,
    params: { per_page: 100, filter: "latest" },
    timeout: 15000,
  });
  const runs = data.check_runs;
  const failedRuns = runs.filter((run) => run.status === "completed" && FAILED_CONCLUSIONS.includes(run.conclusion ?? "")).slice(0, MAX_FAILED_CHECKS);
  const failed = await Promise.all(
    failedRuns.map(async (run) => {
      const summary = [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n");
      const job = run.app?.slug === "github-actions" ? /\/job\/(\d+)/.exec(run.details_url ?? "")?.[1] : undefined;
      let output = summary.slice(-MAX_CHECK_OUTPUT);
      if (job)
        try {
          const log = await axios.get<string>(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job}/logs`, { headers, responseType: "text", timeout: 30000 });
          output = failureExcerpt(log.data);
        } catch (error) {
          // Logs expire or need a permission the App may lack; the summary is still worth reading.
          console.error(`Log of check ${run.name} on ${owner}/${repo}@${sha} could not be read: ${describeError(error)}`);
        }
      return { id: String(run.id), name: run.name, conclusion: run.conclusion ?? "failure", output: output || "No output was available.", url: run.html_url ?? undefined };
    }),
  );
  return { pending: runs.some((run) => run.status !== "completed"), failed };
};

interface GithubReview { id: number; state: string; body: string | null; submitted_at: string | null; user: { login: string; type: string } | null }
interface GithubIssueComment { id: number; body: string | null; created_at: string; user: { login: string; type: string } | null }
interface GithubReviewComment {
  pull_request_review_id: number | null;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  original_start_line: number | null;
  diff_hunk: string;
  body: string;
}

// shortcut: reads the first 300 reviews and review comments; enough for one PR's rounds, page further if a PR ever has more.
const getAllPages = async <T>(url: string, headers: Record<string, string>) => {
  const items: T[] = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await axios.get<T[]>(url, { headers, params: { per_page: 100, page }, timeout: 15000 });
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
};

export const getReviewFeedback = async (installationId: string, owner: string, repo: string, number: number): Promise<ReviewFeedback[]> => {
  const token = await getInstallationToken(installationId);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  // "Comment" reviews also hold single line comments; APPROVED, DISMISSED and PENDING are not feedback.
  const reviews = (await getAllPages<GithubReview>(`${base}/reviews`, headers)).filter((review) => ["CHANGES_REQUESTED", "COMMENTED"].includes(review.state));
  const comments = reviews.length ? await getAllPages<GithubReviewComment>(`${base}/comments`, headers) : [];
  const conversation = await getAllPages<GithubIssueComment>(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, headers);
  const fromReviews: ReviewFeedback[] = reviews.map((review) => ({
    id: String(review.id),
    requestsChanges: review.state === "CHANGES_REQUESTED",
    author: review.user?.login ?? "",
    authorIsBot: review.user?.type !== "User",
    body: review.body ?? "",
    submittedAt: new Date(review.submitted_at ?? Date.now()),
    comments: comments
      .filter((comment) => comment.pull_request_review_id === review.id)
      .map((comment) => ({
        path: comment.path,
        // GitHub drops `line` once later commits change the commented code.
        line: comment.line ?? comment.original_line ?? 0,
        startLine: comment.start_line ?? comment.original_start_line ?? undefined,
        code: comment.diff_hunk,
        body: comment.body,
        outdated: comment.line === null,
      })),
  }));
  const fromConversation: ReviewFeedback[] = conversation.map((comment) => ({
    // Issue comment ids are a different sequence from review ids.
    id: `comment:${comment.id}`,
    requestsChanges: false,
    author: comment.user?.login ?? "",
    authorIsBot: comment.user?.type !== "User",
    body: comment.body ?? "",
    submittedAt: new Date(comment.created_at),
    comments: [],
  }));
  return [...fromReviews, ...fromConversation].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
};

const githubConfigSchema = z.object({ installationId: z.string().min(1) });

/** The connection's installation, else the column repositories had before connections. */
const installationOf = ({ repository, config }: SourceControlTarget) => {
  const installationId = githubConfigSchema.safeParse(config).data?.installationId ?? repository.githubInstallationId;
  if (!installationId)
    throw new NonRetryableError(`Repository ${repository.owner}/${repository.name} has no GitHub installation id`);
  return installationId;
};

export const githubSourceControl: SourceControlAdapter = {
  type: "GITHUB",
  configSchema: githubConfigSchema,
  branchHead: async (target, branch) =>
    getBaseSha(installationOf(target), target.repository.owner, target.repository.name, branch),
  gitToken: async (target) => getInstallationToken(installationOf(target)),
  gitRemote: ({ repository }) => ({
    url: `https://github.com/${repository.owner}/${repository.name}.git`,
    username: "x-access-token",
  }),
  findOpenPullRequest: async (target, head) => {
    const pr = await findOpenPullRequest({ installationId: installationOf(target), owner: target.repository.owner, repo: target.repository.name, head });
    return pr && { number: pr.number, url: pr.html_url };
  },
  createDraftPullRequest: async (target, input) => {
    const pr = await createDraftPullRequest({ installationId: installationOf(target), owner: target.repository.owner, repo: target.repository.name, ...input });
    return { number: pr.number, url: pr.html_url };
  },
  pullRequestOutcome: async (target, number) =>
    getPullRequestOutcome(installationOf(target), target.repository.owner, target.repository.name, number),
  commitChecks: async (target, sha) => getCommitChecks(installationOf(target), target.repository.owner, target.repository.name, sha),
  commentOnPullRequest: async (target, number, body) =>
    commentOnPullRequest(installationOf(target), target.repository.owner, target.repository.name, number, body),
  reviewFeedback: async (target, number) =>
    getReviewFeedback(installationOf(target), target.repository.owner, target.repository.name, number),
};
