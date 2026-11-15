import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";

const url = process.env.DATABASE_URL || "";
const isAccelerate = url.startsWith("prisma");

// Never returned unless a query selects it (services/setupSecrets.ts), so no response can carry it.
const omit = { repository: { encryptedSetupSecrets: true, encryptedTestSecrets: true } } as const;
const prisma = isAccelerate
  ? new PrismaClient({ accelerateUrl: url, omit })
  : new PrismaClient({
      adapter: new PrismaPg(new Pool({ connectionString: url })),
      omit,
    });

/** Postgres jsonb rejects \u0000, which model arguments, replies and tool output can contain. */
export const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "string" ? item.replaceAll("\u0000", "�") : item)),
  ) as Prisma.InputJsonValue;

export default prisma;
