import { ApprovalType, ExecutionStatus } from "@prisma/client";
import prisma from "../db";
import { IssueTrackerAdapter, TrackerComment } from "../integrations/types";
import { describeError } from "../utils/safeError";
import type { AgentPlan } from "./agentGraph/planning";
import { decideApproval, requestPlanRevision } from "./executionService";

/**
 * The conversation about an execution on its ticket: the agent posts its plan
 * and later its change, and approvers reply there. Replies end in the same
 * decisions as the API (decideApproval, requestPlanRevision), so the ticket
 * is one channel and a frontend can be another.
 */

/** Ends every comment the agent posts, so its own comments are never read as replies. */
export const AGENT_SIGNATURE = "— Agent Orchestrator";

export const signed = (text: string) => `${text}\n\n${AGENT_SIGNATURE}`;

export const isAgentComment = (text: string) => text.trimEnd().endsWith(AGENT_SIGNATURE);

const COMMANDS = "Reply `/approve` to go ahead, `/reject <reason>` to stop, or write what should change and I'll revise the plan.";

export const formatPlanComment = (plan: AgentPlan, version: number) =>
  [
    `**Plan${version > 1 ? ` (version ${version})` : ""}:** ${plan.summary}`,
    plan.expectedBehaviour.length
      ? ["**What I understood the change must do:**", ...plan.expectedBehaviour.map((example) => `- ${example}`)].join("\n")
      : "",
    plan.questions.length
      ? ["**I'm not sure about this; if you meant something else, say so:**", ...plan.questions.map((question) => `- ${question}`)].join("\n")
      : "",
    plan.filesToEdit.length ? `**Files I expect to change:** ${plan.filesToEdit.join(", ")}` : "",
    plan.testStrategy.length ? ["**How I'll check it:**", ...plan.testStrategy.map((step) => `- ${step}`)].join("\n") : "",
    COMMANDS,
  ]
    .filter(Boolean)
    .join("\n\n");

/** `verification` is what the checks and the reviewer found (describeVerification). */
export const formatPublishComment = (files: string[], verification: string) =>
  [
    "**The change is ready.**",
    files.length ? `**Changed:** ${files.join(", ")}` : "",
    verification,
    "Reply `/approve` to open a draft pull request, or `/reject <reason>` to stop.",
  ]
    .filter(Boolean)
    .join("\n\n");

export type ReplyAction =
  | { kind: "ignore" }
  | { kind: "unauthorized" }
  | { kind: "approve"; note?: string }
  | { kind: "reject"; reason?: string }
  | { kind: "revise"; feedback: string }
  | { kind: "hint" };

const COMMAND = /^\/(approve|reject)\b\s*([\s\S]*)$/i;
// A reply starting like a command (`/aprove`), not a path such as `/api/users`.
const UNKNOWN_COMMAND = /^\/[a-z]+(\s|$)/i;

/** Who may decide: a tracker user id or name from the connection's `approvers`. */
export const isApprover = (comment: Pick<TrackerComment, "authorId" | "authorName">, approvers: string[]) => {
  const names = approvers.map((approver) => approver.replace(/^@/, "").toLowerCase());
  return names.includes(comment.authorId.toLowerCase()) || names.includes(comment.authorName.toLowerCase());
};

/**
 * What a reply asks for. Only `/approve` approves; on a plan, any other text
 * is feedback for a revision, so a misread reply can at worst cost a revised
 * plan. On a change waiting to be published, only the commands count.
 */
export const replyAction = (comment: TrackerComment, approvers: string[], type: ApprovalType): ReplyAction => {
  const text = comment.text.trim();
  if (!text || isAgentComment(text)) return { kind: "ignore" };
  if (!isApprover(comment, approvers)) return { kind: "unauthorized" };
  const command = COMMAND.exec(text);
  if (command) {
    const rest = command[2].trim() || undefined;
    return command[1].toLowerCase() === "approve" ? { kind: "approve", note: rest } : { kind: "reject", reason: rest };
  }
  // A mistyped command gets a hint instead of costing a revised plan.
  if (UNKNOWN_COMMAND.test(text) || type !== "PLAN") return { kind: "hint" };
  return { kind: "revise", feedback: text };
};

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

const AWAITING: ExecutionStatus[] = ["AWAITING_PLAN_APPROVAL", "AWAITING_PUBLISH_APPROVAL"];

/**
 * Acts on approvers' replies to executions waiting for a decision in the
 * repository this tracker connection feeds. Without `approvers` in the
 * connection's config nothing is read: only the API decides. Only replies
 * after the pending approval was requested count, each one once.
 */
export const handleTicketReplies = async (adapter: IssueTrackerAdapter, trackerConfig: Record<string, unknown>) => {
  const approvers = strings(trackerConfig.approvers);
  if (!approvers.length) return;
  const executions = await prisma.execution.findMany({
    where: {
      repositoryId: String(trackerConfig.repositoryId),
      status: { in: AWAITING },
      workItem: { externalSystem: adapter.externalSystem },
    },
    include: {
      workItem: true,
      approvals: { where: { status: "PENDING" }, orderBy: { requestedAt: "desc" }, take: 1 },
    },
  });
  for (const execution of executions) {
    const approval = execution.approvals[0];
    if (!approval) continue;
    const say = (text: string) => adapter.comment(trackerConfig, execution.workItem.externalId, signed(text));
    try {
      const comments = await adapter.fetchComments(trackerConfig, execution.workItem.externalId, approval.requestedAt);
      for (const comment of comments) {
        if (comment.createdAt <= approval.requestedAt) continue;
        const messageId = `tracker-reply:${adapter.externalSystem}:${comment.id}`;
        if (await prisma.inboxReceipt.findUnique({ where: { messageId } })) continue;
        const action = replyAction(comment, approvers, approval.type);
        await prisma.inboxReceipt.create({ data: { messageId, consumer: "ticket-reply" } });
        if (action.kind === "ignore") continue;
        if (action.kind === "unauthorized") {
          await say(`@${comment.authorName}, only this project's approvers can decide here, so this reply was not acted on.`);
          continue;
        }
        if (action.kind === "hint") {
          await say(approval.type === "PLAN" ? `I didn't act on that. ${COMMANDS}` : "To decide on this change, reply `/approve` or `/reject <reason>`.");
          continue;
        }
        const actor = `${adapter.externalSystem.toLowerCase()}:${comment.authorName}`;
        const what = approval.type === "PLAN" ? "plan" : "change";
        if (action.kind === "revise") {
          const { revised } = await requestPlanRevision(execution.id, approval.snapshotHash, actor, action.feedback);
          await say(revised ? "Thanks, I'm revising the plan with your feedback." : "The plan was revised too many times without approval, so I've stopped.");
        } else {
          const approved = action.kind === "approve";
          const note = approved ? action.note : action.reason;
          await decideApproval(execution.id, approval.type, approved, approval.snapshotHash, actor, note);
          await say(
            approved
              ? approval.type === "PLAN" ? "Plan approved. I'm starting on the change." : "Approved. I'm opening the draft pull request."
              : `Stopped: the ${what} was rejected${note ? ` (${note})` : ""}.`,
          );
        }
        // The approval this reply decided is no longer pending; later replies wait for the next one.
        break;
      }
    } catch (error) {
      console.error(`Ticket replies for execution ${execution.id} failed: ${describeError(error)}`);
    }
  }
};
