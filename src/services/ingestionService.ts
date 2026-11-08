import { ExternalSystem } from "@prisma/client";
import prisma from "../db";
import { AppError } from "../errors/AppError";
import {
  getTrackerAdapter,
  getTrackerAdapterForSystem,
} from "../integrations/trackerRegistry";
import { createExecution } from "./executionService";
import { openIntegrationConfig } from "./integrationConfigService";
import { handleTicketReplies, signed } from "./ticketConversation";

/**
 * Pulls eligible tickets from a tracker connection, upserts them as work
 * items, and creates (idempotently) an execution per ticket revision.
 */
export const syncIntegrationConnection = async (connectionId: string) => {
  const connection = await prisma.integrationConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });
  const adapter = getTrackerAdapter(connection.type);
  if (!adapter)
    throw AppError.badRequest(
      `Integration type ${connection.type} is not an issue tracker and cannot be synced`,
    );

  const trackerConfig = openIntegrationConfig(connection.encryptedConfig);
  const { repositoryId, items } = await adapter.fetchEligibleItems(trackerConfig);
  let ingested = 0;
  for (const item of items) {
    const fields = {
      title: item.title,
      description: item.description,
      labels: item.labels,
      sourceUrl: item.sourceUrl,
      revisionHash: item.revisionHash,
      rawSnapshot: item.rawSnapshot,
    };
    const workItem = await prisma.workItem.upsert({
      where: {
        externalSystem_externalId: {
          externalSystem: adapter.externalSystem,
          externalId: item.externalId,
        },
      },
      create: {
        ...fields,
        externalSystem: adapter.externalSystem,
        externalId: item.externalId,
        boardId: item.boardId,
        projectId: connection.projectId,
      },
      update: fields,
    });
    await createExecution({
      projectId: connection.projectId,
      repositoryId,
      workItemId: workItem.id,
      revisionHash: item.revisionHash,
    });
    ingested++;
  }
  // Decisions approvers replied on tickets since the last poll.
  await handleTicketReplies(adapter, trackerConfig);
  await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: { lastSyncedAt: new Date(), lastError: null },
  });
  return { ingested };
};

/**
 * Posts a comment on the source ticket through the project's enabled
 * connection for that tracker. No-op when no adapter or connection exists.
 */
export const commentOnWorkItem = async (
  projectId: string,
  workItem: { externalSystem: ExternalSystem; externalId: string },
  text: string,
) => {
  const adapter = getTrackerAdapterForSystem(workItem.externalSystem);
  if (!adapter) return;
  const connection = await prisma.integrationConnection.findFirst({
    where: { projectId, type: adapter.type, enabled: true },
  });
  if (!connection) return;
  await adapter.comment(
    openIntegrationConfig(connection.encryptedConfig),
    workItem.externalId,
    signed(text),
  );
};
