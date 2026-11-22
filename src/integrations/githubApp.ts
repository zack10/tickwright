import axios from "axios";
import crypto from "node:crypto";

import { z } from "zod";

import { config } from "../config";
import { NonRetryableError } from "../utils/safeError";
import { SourceControlAdapter, SourceControlTarget } from "./types";

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
};
