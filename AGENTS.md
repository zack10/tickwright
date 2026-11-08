# AGENTS.md - Tickwright

## Dev Commands

```powershell
# Prerequisites: Docker Desktop running
docker-compose up -d

# Local dev (uses .env.local - Docker Postgres + local RabbitMQ)
npm run dev:local

# Cloud dev (uses .env.cloud - Prisma Accelerate)
npm run dev:cloud

# Database sync
npm run prisma:push:local   # schema to local Docker DB
npm run prisma:push:cloud # schema to Prisma cloud

# Build & verify
npm run build
npm run lint
npm run lint:fix
```

## Architecture

- **Entry**: `src/index.ts` (Express + routes)
- **Port**: 3001
- **DB**: Prisma ORM → PostgreSQL (local: port 15432, cloud: Accelerate)
- **Messaging**: RabbitMQ (port 5672, mgmt UI host port: 25672)
- **LLM Providers**: Gemini, OpenAI, Anthropic in `src/services/llm/providers/`

## Project Structure

```
src/
├── controllers/   # Request handlers
├── routes/         # Express route definitions
├── services/       # Core business logic
│   ├── llm/          # LLM abstraction (Gemini, OpenAI, Anthropic)
│   │   └── providers/
│   ├── connectors/  # MCP external integrations
│   ├── agentRunner.ts
│   ├── mcpService.ts
│   └── rabbitMQService.ts
├── schemas/        # Zod validation
├── types/          # TypeScript types
└── middleware/    # Express middleware
```

## Environment Files

| File | Database | Use |
|------|----------|-----|
| `.env.local` | Docker Postgres (port 15432) | Local dev |
| `.env.cloud` | Prisma Accelerate | Cloud dev |

Both require RabbitMQ at `localhost:5672`.

## Prisma

- Models in `prisma/schema.prisma`
- Run `npx prisma studio` to browse data
- Use dotenv-cli to load correct env: `dotenv -e .env.local -- npx prisma <command>`

## LLM Configuration

Configured in `opencode.json` provider settings. Uses `@ai-sdk/openai-compatible` for LM Studio at `http://localhost:1234/v1`.

## Important Notes

- Prisma client is imported from `src/db.ts`
- WorkItem model tracks external system tasks (Trello, Jira)
- Agent model supports skills and MCP resources per agent
- Use `npm run dev:local` for most development - cloud requires Prisma Accelerate setup
