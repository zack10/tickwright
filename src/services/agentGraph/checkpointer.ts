import { RunnableConfig } from "@langchain/core/runnables";
import { Checkpoint, CheckpointMetadata, MemorySaver } from "@langchain/langgraph";
import prisma from "../../db";
import { decrypt, encrypt } from "../../utils/crypto";

/**
 * Where a thread's checkpoints are kept between runs. The Prisma version
 * stores one encrypted row per execution: the state holds the agent's API
 * key, so it is never stored in the clear.
 */
export interface CheckpointStore {
  load(threadId: string): Promise<string | undefined>;
  save(threadId: string, data: string): Promise<void>;
  delete(threadId: string): Promise<void>;
}

export const prismaCheckpointStore: CheckpointStore = {
  async load(threadId) {
    const row = await prisma.graphCheckpoint.findUnique({ where: { executionId: threadId } });
    return row ? decrypt(row.data) : undefined;
  },
  async save(threadId, data) {
    const sealed = encrypt(data);
    await prisma.graphCheckpoint.upsert({
      where: { executionId: threadId },
      create: { executionId: threadId, data: sealed },
      update: { data: sealed },
    });
  },
  async delete(threadId) {
    await prisma.graphCheckpoint.deleteMany({ where: { executionId: threadId } });
  },
};

// Resuming needs the latest checkpoint and its pending writes; the parent is
// kept so the latest one never refers to a missing entry.
const KEEP_CHECKPOINTS = 2;

type Storage = MemorySaver["storage"][string];
type Writes = MemorySaver["writes"];

const threadOf = (config: RunnableConfig) => config.configurable?.thread_id as string | undefined;
// MemorySaver's key for a checkpoint's pending writes.
const writesKeyParts = (key: string) => JSON.parse(key) as [string, string | null, string];

// Checkpoints and writes are serialized bytes; JSON keeps them as base64.
const encode = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Uint8Array ? { $bytes: Buffer.from(item).toString("base64") } : item,
  );
const decode = (text: string) =>
  JSON.parse(text, (_key, item) =>
    item && typeof item === "object" && typeof item.$bytes === "string"
      ? new Uint8Array(Buffer.from(item.$bytes, "base64"))
      : item,
  ) as { storage: Storage; writes: Writes };

/**
 * LangGraph's MemorySaver, with each thread written to a store after every
 * step, so a run that fails or whose worker dies continues from its last
 * completed node instead of starting over. Only the latest checkpoints are
 * kept: they are what resuming needs.
 */
export class DurableCheckpointSaver extends MemorySaver {
  private loaded = new Set<string>();

  constructor(private readonly store: CheckpointStore) {
    super();
  }

  /** Drops a thread from memory, so the next access reads the stored copy (another worker may have advanced it). */
  evict(threadId: string) {
    this.loaded.delete(threadId);
    delete this.storage[threadId];
    for (const key of Object.keys(this.writes)) if (writesKeyParts(key)[0] === threadId) delete this.writes[key];
  }

  private async load(threadId: string | undefined) {
    if (!threadId || this.loaded.has(threadId)) return;
    const stored = await this.store.load(threadId);
    if (stored) {
      const { storage, writes } = decode(stored);
      this.storage[threadId] = storage;
      Object.assign(this.writes, writes);
    }
    this.loaded.add(threadId);
  }

  private async persist(threadId: string) {
    const storage = this.storage[threadId] ?? {};
    const keep = new Set<string>();
    for (const [namespace, checkpoints] of Object.entries(storage)) {
      const ids = Object.keys(checkpoints).sort((a, b) => b.localeCompare(a));
      for (const id of ids.slice(KEEP_CHECKPOINTS)) delete checkpoints[id];
      for (const id of ids.slice(0, KEEP_CHECKPOINTS)) keep.add(JSON.stringify([namespace, id]));
    }
    const writes: Writes = {};
    for (const [key, value] of Object.entries(this.writes)) {
      const [thread, namespace, id] = writesKeyParts(key);
      if (thread !== threadId) continue;
      if (keep.has(JSON.stringify([namespace ?? "", id]))) writes[key] = value;
      else delete this.writes[key];
    }
    await this.store.save(threadId, encode({ storage, writes }));
  }

  async getTuple(config: RunnableConfig) {
    await this.load(threadOf(config));
    return super.getTuple(config);
  }

  async *list(config: RunnableConfig, options?: Parameters<MemorySaver["list"]>[1]) {
    await this.load(threadOf(config));
    yield* super.list(config, options);
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    const threadId = threadOf(config);
    await this.load(threadId);
    const saved = await super.put(config, checkpoint, metadata);
    if (threadId) await this.persist(threadId);
    return saved;
  }

  async putWrites(config: RunnableConfig, writes: Parameters<MemorySaver["putWrites"]>[1], taskId: string) {
    const threadId = threadOf(config);
    await this.load(threadId);
    await super.putWrites(config, writes, taskId);
    if (threadId) await this.persist(threadId);
  }

  async deleteThread(threadId: string) {
    this.evict(threadId);
    await this.store.delete(threadId);
  }
}
