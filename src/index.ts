import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { config, validateProductionConfig } from "./config";
import prisma from "./db";
import { AppError } from "./errors/AppError";
import { authenticate } from "./middleware/authenticate";
import { errorHandler } from "./middleware/errorHandler";
import { rateLimit } from "./middleware/rateLimit";
import { securityHeaders } from "./middleware/securityHeaders";
import agentRoutes from "./routes/agentRoutes";
import executionRoutes from "./routes/executionRoutes";
import llmRoutes from "./routes/llmRoutes";
import projectRoutes from "./routes/projectRoutes";
import skillRoutes from "./routes/skillRoutes";
import taskRoutes from "./routes/taskRoutes";
import {
  startExecutionWorkers,
  stopExecutionWorkers,
} from "./services/executionWorker";
import { startOutbox, stopOutbox } from "./services/outboxService";
import rabbitMQService from "./services/rabbitMQService";
import taskQueueService from "./services/taskQueueService";
import {
  startIntegrationPolling,
  stopIntegrationPolling,
} from "./services/integrationPollingService";
import { getProviderRegistry } from "./services/llm/registry";

dotenv.config();

const app = express();
validateProductionConfig();
// Fails at boot on an invalid LLM_PROVIDERS or default provider.
getProviderRegistry();

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(
  cors({
    origin(origin, callback) {
      // Non-browser clients send no Origin; browsers must be allowlisted.
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(AppError.forbidden("Origin is not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  checks.rabbitmq = rabbitMQService.isConnected() ? "ok" : "error";

  const healthy = Object.values(checks).every((v) => v === "ok");
  res
    .status(healthy ? 200 : 503)
    .json({ status: healthy ? "healthy" : "degraded", checks });
});

app.use("/api", authenticate);
app.use("/api", rateLimit);
app.use("/api/agents", agentRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/skills", skillRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/llm", llmRoutes);
app.use("/api", executionRoutes);

app.get("/", (_req: Request, res: Response) => {
  res.send("Tickwright API is running");
});

app.use(errorHandler);

async function start() {
  try {
    await rabbitMQService.connect();
    await taskQueueService.start();
    await startExecutionWorkers();
    await startOutbox();
    await startIntegrationPolling();
  } catch (err) {
    if (config.nodeEnv === "production") throw err;
    console.warn(
      "RabbitMQ task worker unavailable at startup; API will run in degraded mode",
    );
  }

  const server = app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log("Shutting down gracefully...");
    taskQueueService.stop();
    stopOutbox();
    stopIntegrationPolling();
    stopExecutionWorkers();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rabbitMQService.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start();
