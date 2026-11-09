import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

const url = process.env.DATABASE_URL || "";
const isAccelerate = url.startsWith("prisma");

// Never returned unless a query selects it (services/setupSecrets.ts), so no response can carry it.
const omit = { repository: { encryptedSetupSecrets: true } } as const;
const prisma = isAccelerate
  ? new PrismaClient({ accelerateUrl: url, omit })
  : new PrismaClient({
      adapter: new PrismaPg(new Pool({ connectionString: url })),
      omit,
    });

export default prisma;
