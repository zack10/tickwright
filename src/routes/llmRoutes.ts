import { Router } from "express";
import { AppError } from "../errors/AppError";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { discoverProviderSchema, providerQuerySchema } from "../schemas";
import { LLMService } from "../services/llm/LLMService";
import { getProviderRegistry } from "../services/llm/registry";

const router = Router();
const llmService = new LLMService();

router.get("/providers", (_req, res) => {
  const registry = getProviderRegistry();
  res.json({
    providers: registry.list().map((provider) => provider.key),
    details: registry.list(),
    default: { provider: registry.defaultProvider, model: registry.defaultModel },
  });
});

router.post(
  "/discover",
  validate(discoverProviderSchema),
  asyncHandler(async (req, res) => {
    const { provider, apiKey } = req.body;
    const result = await llmService.discover(provider, apiKey);
    res.json(result);
  }),
);

router.get(
  "/models",
  validate(providerQuerySchema),
  asyncHandler(async (req, res) => {
    const provider = req.query.provider as string;
    const apiKey = req.header("x-provider-api-key");
    const models = await llmService.listModels(provider, apiKey);
    res.json({ models });
  }),
);

// Tokens all model calls used today (UTC), against LLM_DAILY_TOKEN_LIMIT.
router.get(
  "/usage/today",
  asyncHandler(async (_req, res) => {
    res.json(await llmService.usageToday());
  }),
);

router.get(
  "/usage",
  validate(providerQuerySchema),
  asyncHandler(async (req, res) => {
    const provider = req.query.provider as string;
    const usage = await llmService.getUsage(provider);
    if (!usage.available) res.status(501);
    res.json({ usage });
  }),
);

router.use(() => {
  throw AppError.notFound("LLM endpoint not found");
});

export default router;
