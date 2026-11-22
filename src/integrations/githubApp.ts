import axios from "axios";
import crypto from "node:crypto";

import { config } from "../config";
import { SourceControlAdapter } from "./types";

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

export const githubSourceControl: SourceControlAdapter = {
  branchHead: (repository, branch) =>
    getBaseSha(repository.githubInstallationId, repository.owner, repository.name, branch),
  gitToken: (repository) => getInstallationToken(repository.githubInstallationId),
  findOpenPullRequest: async (repository, head) => {
    const pr = await findOpenPullRequest({ installationId: repository.githubInstallationId, owner: repository.owner, repo: repository.name, head });
    return pr && { number: pr.number, url: pr.html_url };
  },
  createDraftPullRequest: async (repository, input) => {
    const pr = await createDraftPullRequest({ installationId: repository.githubInstallationId, owner: repository.owner, repo: repository.name, ...input });
    return { number: pr.number, url: pr.html_url };
  },
};
