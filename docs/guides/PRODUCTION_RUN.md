# Running the production version

The app as a user runs it: the built image (`Dockerfile`) with its own PostgreSQL
and RabbitMQ (`docker-compose.prod.yml`), `NODE_ENV=production`. Evals, live
ticket checks and release checks run against this; day-to-day coding and unit
tests stay on `npm run dev:local`.

| Mode | Command | For |
| :--- | :--- | :--- |
| Development | `npm run dev:local` (Windows or Linux) | coding, unit tests, light features |
| Production | `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build` | agent runs on real projects, evals, release checks |

Don't run both at once: both listen on port 3001 (set `APP_PORT` to move the production one).

## Where to run it

On a Linux filesystem. Workspaces (clones, installs, builds) are bind-mounted into
the execution containers, and through a Windows mount (`F:\`, `/mnt/f`) installs and
compiles are many times slower.

- **Linux** (laptop or server): any folder.
- **Windows**: from a WSL2 distribution (e.g. Ubuntu) with Docker Desktop's WSL
  integration turned on for it (Settings → Resources → WSL integration). The command
  can run in the Windows checkout (`cd /mnt/f/...`): only the image build reads
  it. `AGENT_DATA_DIR` must be under the distribution's own filesystem (`/home/...`).
- **Windows without WSL**: not supported yet. Docker would need to mount
  workspaces from a named volume instead of a host folder (roadmap, Known limitations).

## First start

1. `cp .env.prod.example .env.prod` and fill it in. It has the settings that differ
   from `.env.example`; any other setting from there can be added.
2. `mkdir -p "$AGENT_DATA_DIR/generated-code"` (the path from `.env.prod`).
3. Start it. The `migrate` service applies the migrations, then the app starts:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
   curl http://localhost:3001/health
   ```
4. Calls need `Authorization: Bearer $API_AUTH_TOKEN`. For the e2e suites and evals
   set `E2E_API_TOKEN` in `.env.e2e` to the same value. Evals read the agent's diff
   from the server's disk: run from Windows, set `E2E_ARTIFACT_DIR` to the artifacts
   folder as Windows sees it (`//wsl.localhost/<distribution>$AGENT_DATA_DIR/artifacts`).

The production database is separate from the development one (its own volume), so
agents, integrations and repositories are created again there.

After a code change, run step 3 again. Only changed layers rebuild (dependencies
are reinstalled only when `package-lock.json` changes). Never restart it while an
execution runs: the run is lost.

Logs: `docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f app`.
Stop: `... down` (data stays in the volumes and `AGENT_DATA_DIR`); `down -v` also
deletes the database.

## Security

- **Docker socket.** The app starts execution containers on the host's Docker
  through `/var/run/docker.sock`, which is root-equivalent on that machine. That is
  how self-hosted CI runners work and is fine on a machine you own. A shared
  server needs rootless Docker or a separate machine for executions (roadmap Phase 14).
  For the same reason the app container runs as root: workspace containers write
  files as root, which the app must edit and delete.
- **Agent code never gets the socket.** It runs in the execution containers
  (no internet, only the run's services, resource limits, `.git` read-only).
- **Nothing is exposed but the API**, and that only on `127.0.0.1`. PostgreSQL and
  RabbitMQ are reachable only from inside the stack, with the passwords from `.env.prod`.
- **Secrets stay out of the image.** `.dockerignore` lets only the sources in;
  `.env.prod` is read when the container starts and is gitignored.
- `ENCRYPTION_KEY` encrypts integration credentials in the database: losing or
  changing it makes them unreadable.

## WSL notes

- If `docker` in WSL fails with `docker-credential-desktop.exe: executable file not
  found`, add Docker Desktop's tools to the PATH (e.g. in `~/.profile`):
  `export PATH="$PATH:/mnt/c/Program Files/Docker/Docker/resources/bin"`.
- WSL takes memory as it needs it and is slow to give it back. Cap it in
  `%UserProfile%\.wslconfig`:
  ```ini
  [wsl2]
  memory=6GB
  [experimental]
  autoMemoryReclaim=gradual
  ```
  then `wsl --shutdown`. Docker Desktop's containers count against this cap too.
