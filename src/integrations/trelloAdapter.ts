import { Prisma } from "@prisma/client";
import axios from "axios";
import crypto from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/AppError";
import { IssueTrackerAdapter, NormalizedWorkItem, TrackerComment } from "./types";

// Other keys (approvers) are the tracker-neutral settings; the route checks those.
const trelloConfigSchema = z.object({
  apiKey: z.string().min(1),
  token: z.string().min(1),
  boardId: z.string().min(1),
  eligibleLabel: z.string().min(1),
  // Names of the lists whose cards are ready for the agent; a labelled card elsewhere (Backlog, Done) is not picked up.
  eligibleLists: z.array(z.string().min(1).max(200)).min(1).max(20),
  repositoryId: z.string().uuid(),
});
type TrelloConfig = z.infer<typeof trelloConfigSchema>;
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  idList: string;
  labels: Array<{ id?: string; name: string }>;
}
/** A card's "commentCard" action, as GET /cards/:id/actions returns it. */
export interface TrelloCommentAction {
  id: string;
  date: string;
  idMemberCreator: string;
  memberCreator?: { username?: string; fullName?: string };
  data: { text?: string };
}

/** Comments oldest first; Trello lists actions newest first. */
export const toComments = (actions: TrelloCommentAction[]): TrackerComment[] =>
  actions
    .map((action) => ({
      id: action.id,
      authorId: action.idMemberCreator,
      authorName: action.memberCreator?.username ?? action.idMemberCreator,
      text: action.data.text ?? "",
      createdAt: new Date(action.date),
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

const asConfig = (value: Record<string, unknown>): TrelloConfig =>
  value as unknown as TrelloConfig;

/**
 * The ids of the board's lists named in `eligibleLists` (case-insensitive).
 * A name the board does not have is an error, not an empty match: after a
 * list is renamed, nothing would be picked up and nobody would be told.
 */
export const readyListIds = (lists: Array<{ id: string; name: string }>, eligibleLists: string[] | undefined) => {
  if (!eligibleLists?.length)
    throw AppError.badRequest("This Trello connection names no ready lists (eligibleLists); create it again with the lists whose cards the agent may pick up");
  const ids = new Set<string>();
  for (const wanted of eligibleLists) {
    const list = lists.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
    if (!list) throw AppError.badRequest(`Trello list "${wanted}" is not on the board (lists: ${lists.map((candidate) => candidate.name).join(", ")})`);
    ids.add(list.id);
  }
  return ids;
};

/**
 * Filters cards to the eligible label and the ready lists, and maps them to work items.
 * The revision hash formula is unchanged from the original adapter so
 * existing cards keep their execution idempotency keys.
 */
export const toWorkItems = (
  cards: TrelloCard[],
  config: Pick<TrelloConfig, "boardId" | "eligibleLabel">,
  readyLists: Set<string>,
): NormalizedWorkItem[] =>
  cards
    .filter((card) =>
      readyLists.has(card.idList) &&
      card.labels.some(
        (label) =>
          label.name.toLowerCase() === config.eligibleLabel.toLowerCase(),
      ),
    )
    .map((card) => ({
      externalId: card.id,
      boardId: config.boardId,
      title: card.name,
      description: card.desc,
      labels: card.labels,
      sourceUrl: card.url,
      revisionHash: crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            name: card.name,
            desc: card.desc,
            // Not whole labels: their `uses` count changes on every card when any
            // card gets or loses the label, which re-ran every labelled card.
            labels: card.labels.map(({ id, name }) => ({ id, name })),
            idList: card.idList,
          }),
        )
        .digest("hex"),
      rawSnapshot: card as unknown as Prisma.InputJsonObject,
    }));

export const trelloAdapter: IssueTrackerAdapter = {
  type: "TRELLO",
  externalSystem: "TRELLO",
  configSchema: trelloConfigSchema,

  async fetchEligibleItems(rawConfig) {
    const config = asConfig(rawConfig);
    const lists = await axios.get<Array<{ id: string; name: string }>>(
      `https://api.trello.com/1/boards/${encodeURIComponent(config.boardId)}/lists`,
      { params: { key: config.apiKey, token: config.token, fields: "name" }, timeout: 15000 },
    );
    const ready = readyListIds(lists.data, config.eligibleLists);
    const response = await axios.get<TrelloCard[]>(
      `https://api.trello.com/1/boards/${encodeURIComponent(config.boardId)}/cards`,
      {
        params: {
          key: config.apiKey,
          token: config.token,
          fields: "name,desc,url,idList,labels",
        },
        timeout: 15000,
      },
    );
    return {
      repositoryId: config.repositoryId,
      items: toWorkItems(response.data, config, ready),
    };
  },

  async comment(rawConfig, cardId, text) {
    const config = asConfig(rawConfig);
    await axios.post(
      `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}/actions/comments`,
      null,
      {
        params: { key: config.apiKey, token: config.token, text },
        timeout: 15000,
      },
    );
  },

  async fetchComments(rawConfig, cardId, since) {
    const config = asConfig(rawConfig);
    const response = await axios.get<TrelloCommentAction[]>(
      `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}/actions`,
      {
        params: {
          key: config.apiKey,
          token: config.token,
          filter: "commentCard",
          since: since.toISOString(),
          limit: 50,
          memberCreator_fields: "username,fullName",
        },
        timeout: 15000,
      },
    );
    return toComments(response.data);
  },
};
