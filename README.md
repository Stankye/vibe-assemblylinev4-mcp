# AssemblyLine 4 MCP Server

MCP server for the [AssemblyLine 4](https://cybercentrecanada.github.io/assemblyline4_docs/) malware analysis platform.

## Setup

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your credentials:

```
AL4_URL=https://your-al4-instance:443
AL4_USERNAME=your_username
AL4_APIKEY=keyname:your_api_key_password
```

API keys are created in AssemblyLine under **Account → Security → Manage API Keys**.

## Running

```bash
AL4_URL=... AL4_USERNAME=... AL4_APIKEY=... node dist/src/index.js
```

## Claude Code integration

Add to your `~/.claude/claude_desktop_config.json` (or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "assemblyline4": {
      "command": "node",
      "args": ["/absolute/path/to/vibe-assemblylinev4-mcp/dist/src/index.js"],
      "env": {
        "AL4_URL": "https://your-al4-instance:443",
        "AL4_USERNAME": "your_username",
        "AL4_APIKEY": "keyname:password"
      }
    }
  }
}
```

### Self-signed / dev certificates

Set `AL4_TLS_VERIFY=false` in the env block to skip TLS verification.

## Available tools

| Tool | Description |
|------|-------------|
| `al4_whoami` | Current authenticated user |
| `al4_submit_file` | Sync file submission (path on disk) |
| `al4_submit_url` | Sync URL submission |
| `al4_submit_sha256` | Sync submission by hash (file must exist in AL4 store) |
| `al4_ingest_file` | Async file ingestion with optional notification queue |
| `al4_ingest_url` | Async URL ingestion |
| `al4_ingest_sha256` | Async hash ingestion |
| `al4_submission_is_complete` | Poll whether a submission has finished |
| `al4_submission_get` | Submission metadata |
| `al4_submission_full` | Complete results tree |
| `al4_submission_summary` | Summarised results |
| `al4_ingest_get_messages` | Drain a notification queue |
| `al4_search_submissions` | Lucene search over submissions |
| `al4_search_alerts` | Lucene search over alerts |
| `al4_search_files` | Lucene search over the file store |
| `al4_search_results` | Lucene search over service results |
| `al4_alert_get` | Fetch a single alert by ID |
| `al4_file_info` | File metadata by SHA256 |
| `al4_file_results` | All service results for a file |
| `al4_file_score` | Highest score for a file |

## Testing & CI

Two layers of tests live under `test/`:

- `test/integration.ts` — drives `AL4Client` and the MCP server end-to-end
  against an in-process **mock** of the AL4 REST API (`test/mock-al4.ts`).
  Fast, hermetic, runs on every push/PR via `.github/workflows/ci.yml`.

  ```bash
  npm test
  ```

- `test/e2e.ts` — drives `AL4Client` against a **real** Assemblyline 4
  appliance. The `.github/workflows/e2e.yml` workflow spins up the upstream
  [`assemblyline-docker-compose`](https://github.com/CybercentreCanada/assemblyline-docker-compose)
  appliance (core stack only — Elasticsearch, Redis, MinIO, AL core/UI/nginx;
  service images are skipped to fit the runner's disk quota), bootstraps the
  admin user, mints an API key, and runs the suite. Because submissions are
  not blocked on services, they complete with an empty result tree — enough
  to validate every API the MCP server exposes.

  The e2e workflow runs:
  - nightly (05:27 UTC),
  - on `workflow_dispatch`,
  - on PRs labelled `run-e2e`.

  To reproduce locally:

  ```bash
  bash scripts/ci/start-al4.sh
  APIKEY=$(AL4_URL=https://localhost AL4_ADMIN_USER=admin AL4_ADMIN_PASSWORD=admin \
           bash scripts/ci/create-apikey.sh)
  AL4_URL=https://localhost AL4_USERNAME=admin AL4_APIKEY=$APIKEY \
    AL4_TLS_VERIFY=false node dist/test/e2e.js
  ```

### Running CI locally

Two equivalent paths, depending on what you want to validate:

1. **The fast workflow, exactly as GitHub Actions runs it** — via
   [`act`](https://github.com/nektos/act):

   ```bash
   # one-time: install act (https://nektosact.com/installation/)
   npm run ci:local            # runs .github/workflows/ci.yml in Docker
   ```

   `act` reads `.actrc`, which pins the catthehacker `ubuntu:act-latest`
   image (has Node, git, curl, etc.). This is the cleanest way to catch
   regressions in the workflow YAML itself.

2. **The e2e workflow** — `act` is *not* recommended here because the job
   spins up its own docker-compose stack, and docker-in-docker via `act`
   makes networking and disk usage painful. Use the wrapper script
   instead, which runs the same steps directly on your host:

   ```bash
   npm run e2e:local           # build → start appliance → mint key → run e2e → teardown
   KEEP_RUNNING=1 npm run e2e:local   # leave appliance up afterwards for poking
   SKIP_BUILD=1   npm run e2e:local   # skip npm ci + tsc, reuse dist/
   ```

   Or break it apart:

   ```bash
   npm run e2e:up              # just bring up the appliance
   APIKEY=$(npm run --silent e2e:apikey)
   AL4_URL=https://localhost AL4_USERNAME=admin AL4_APIKEY=$APIKEY \
     AL4_TLS_VERIFY=false npm run test:e2e
   ```

   Requirements: Linux host (or WSL2 / macOS), docker + compose plugin,
   node 20+, ~15 GB free disk. Windows users: run the scripts from inside
   WSL — the appliance won't come up under Git Bash because of how
   docker-compose paths and `openssl` interact on native Windows.
