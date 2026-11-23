import axios from "axios";
import crypto from "node:crypto";

import { z } from "zod";

import { config } from "../config";
import { NonRetryableError } from "../utils/safeError";
import { ReviewFeedback, PullRequestOutcome, SourceControlAdapter, SourceControlTarget } from "./types";

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
  commentOnPullRequest: async (target, number, body) =>
    commentOnPullRequest(installationOf(target), target.repository.owner, target.repository.name, number, body),
  reviewFeedback: async (target, number) =>
    getReviewFeedback(installationOf(target), target.repository.owner, target.repository.name, number),
};
