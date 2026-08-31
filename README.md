# archmap

**Architecture Mapper** — one knowledge graph plus an AI agent layer for your codebase.

> **Question:** "If I change this piece of code, what else could be affected, and why?"

`archmap` indexes a repository into one local SQLite graph, then uses that graph **and an LLM** to explain structure, impact, flows, tests, docs, risks, and to run bounded agent workflows before you change code.

The parser and graph are the source of architectural truth. The model narrates, plans, debates, and hypothesizes from **names and snippets already in the graph**. It does not invent edges.

---

## Quick Start

```bash
# 1. Install globally
cd D:\code\archmapper
npm install
npm run build
npm i -g .

# 2. Set up your API key (create .env in any repo you use)
echo "ARCHMAP_LLM_API_KEY=your-key" > .env
echo "ARCHMAP_LLM_BASE_URL=https://openrouter.ai/api/v1" >> .env
echo "ARCHMAP_LLM_MODEL=meta-llama/llama-3.3-70b-instruct" >> .env
echo "ARCHMAP_LLM_CHEAP_MODEL=qwen/qwen3-30b-a3b" >> .env

# 3. Index a repo
cd D:\path\to\your-repo
archmap init

# 4. Chat with your codebase
archmap chat
```

---

## How to use it

You always work in **two places**:

1. The **archmap source tree** — install the CLI once.
2. The **repository you want to understand** — run `archmap init` here, then every later command.

Commands read `.archmap/index.db` from the **current working directory**. Installing in `D:\code\archmapper` and then running `archmap impact` there does **not** analyze some other clone.

### 1. Install the CLI

```powershell
cd D:\code\archmapper
npm install
npm run build
npm i -g .
archmap --help
```

### 2. Set your API key

archmap works **without any API key** — all deterministic features (impact, diff, search, UI) work out of the box.

To unlock the **AI agent** (`archmap chat`), **narration**, and **orchestration**, add your preferred LLM provider's API key.

**The easiest way:** create a `.env` file in any repo you use archmap in:

```bash
# Just pick ONE provider and paste your key:

# OpenRouter (free models available — recommended to start)
ARCHMAP_LLM_BASE_URL=https://openrouter.ai/api/v1
ARCHMAP_LLM_MODEL=meta-llama/llama-3.3-70b-instruct
ARCHMAP_LLM_CHEAP_MODEL=qwen/qwen3-30b-a3b
ARCHMAP_LLM_API_KEY=sk-or-v1-your-key-here

# OpenAI
# ARCHMAP_LLM_BASE_URL=https://api.openai.com/v1
# ARCHMAP_LLM_MODEL=gpt-4o
# ARCHMAP_LLM_CHEAP_MODEL=gpt-4o-mini
# ARCHMAP_LLM_API_KEY=sk-your-key-here

# Google Gemini
# ARCHMAP_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
# ARCHMAP_LLM_MODEL=gemini-3.6-flash
# ARCHMAP_LLM_API_KEY=AIza-your-key-here

# Ollama (local, free, no key needed)
# ARCHMAP_LLM_BASE_URL=http://localhost:11434/v1
# ARCHMAP_LLM_MODEL=llama3.3
# ARCHMAP_LLM_CHEAP_MODEL=llama3.1
# ARCHMAP_LLM_API_KEY=ollama

# xAI / Grok
# ARCHMAP_LLM_BASE_URL=https://api.x.ai/v1
# ARCHMAP_LLM_MODEL=grok-4.6
# ARCHMAP_LLM_CHEAP_MODEL=grok-4.3
# ARCHMAP_LLM_API_KEY=xai-your-key-here

# Any other OpenAI-compatible API
# ARCHMAP_LLM_BASE_URL=https://your-provider.com/v1
# ARCHMAP_LLM_MODEL=your-strong-model
# ARCHMAP_LLM_CHEAP_MODEL=your-cheap-model
# ARCHMAP_LLM_API_KEY=your-key
```

**How it works:** archmap reads your `.env` file automatically. Copy the same `.env` to any repo where you use archmap. The LLM is **optional** — everything works without it, but the AI agent, narration, and orchestration are much better with it.

| Setting | What it does | Default |
|---|---|---|
| `ARCHMAP_LLM_API_KEY` | Your API key (any provider) | — |
| `ARCHMAP_LLM_BASE_URL` | API endpoint URL | `https://api.x.ai/v1` |
| `ARCHMAP_LLM_MODEL` | Strong model (planning, chat, orchestration) | `grok-4.6` |
| `ARCHMAP_LLM_CHEAP_MODEL` | Cheap model (narration, summaries) | `grok-4.3` |
| `ARCHMAP_LLM_TIMEOUT_MS` | Request timeout in milliseconds | `20000` |
| `GEMINI_API_KEY` | Shorthand for Gemini (auto-detects URL) | — |
| `XAI_API_KEY` | Shorthand for xAI/Grok (auto-detects URL) | — |

### 3. Index a repository

```powershell
cd D:\path\to\the-repo-you-care-about
archmap init
```

After you change a lot of code, re-index:

```bash
archmap analyze          # alias: archmap sync
```

### 4. Chat with your codebase (NEW)

```bash
archmap chat
```

An interactive AI agent that explores your codebase autonomously. Ask questions in natural language — it runs tools, reasons about results, and gives structured answers.

```
archmap> what breaks if I change Navigation?

  Running: impact Navigation
  Running: explain Navigation
**Impact Analysis**
* Affected: @/components/navigation (External)
* Risks: No tests found
* Recommendation: Add test coverage

Would you like me to trace the dependency chain?
```

**What the agent can do:**
- Analyze impact of changes
- Explain code components
- Trace data flows
- Plan safe refactors
- Suggest file edits (with confirmation)
- Find tests to run
- Verify changes
- Self-reflect on answer quality
- Proactively suggest next steps

### 5. Other commands

```bash
archmap summary                 # what's in the graph
archmap search catalog          # find by name
archmap explain createItem      # what does this do?
archmap impact createItem       # what breaks if I change this?
archmap diff                    # uncommitted git changes vs HEAD
archmap ui                      # http://localhost:3743
```

### 6. Agent workflows

```bash
archmap orchestrate "what happens if I change createItem"
archmap plan_change createItem
archmap agent verify --target createItem
```

---

## Which command when

| You want to… | Run |
|---|---|
| Chat with your codebase | `archmap chat` |
| See if the index exists / how big it is | `status`, `summary` |
| Find a symbol whose name you barely know | `search`, or omit the argument for a picker |
| Understand one function | `explain` |
| Know who would break if you edit it | `impact` |
| See the execution story, in order | `flow` |
| See why A reaches B | `trace` |
| Know which tests to run | `tests` |
| See the whole architecture | `map`, `ui`, `insights` |
| Know impact of **your uncommitted edits** | `diff` |
| Know impact of a branch / PR | `diff main HEAD` |
| Get a file list an agent may touch | `plan_change` |
| Have the agent do the whole briefing | `orchestrate "..."` |
| Check an agent did not wander | `agent verify` |
| Re-index after you changed source | `analyze` |

---

## Requirements

- Node.js **22.5+** (`node:sqlite`)
- npm
- Git — only required for `archmap diff`
- LLM API key — required for narration, orchestrate, chat, debate

```bash
node --version
npm --version
git --version
```

**Languages indexed:** TypeScript/JavaScript, Python, Java, Go, Rust, Ruby, PHP, C#, Swift, Kotlin, Scala, C/C++, plus manifests (`package.json`, `go.mod`, `Cargo.toml`, `pom.xml`, Gradle, `Gemfile`, `composer.json`, `requirements.txt`, `pyproject.toml`) and SQL/Prisma/OpenAPI-ish config when present.

---

## Commands

Most `[thing]` arguments open a numbered picker if omitted. `--json` prints the canonical envelope (for scripts, MCP, CI).

### `archmap chat`

Interactive AI agent. Ask questions in natural language — the agent explores your codebase autonomously.

```bash
archmap chat
# Then ask anything:
# "what breaks if I change Navigation?"
# "show me the working tree changes"
# "plan a safe refactor of the LLM module"
# "explain the data flow from form to database"
```

**Advanced agent features:**
- **Self-reflection** — evaluates answer quality before responding
- **Proactive suggestions** — suggests next steps after answering
- **Code editing** — can suggest file edits (with user confirmation)
- **Multi-step planning** — creates refactoring plans
- **Error recovery** — tries alternative approaches when tools fail
- **Verification** — verifies changes against the graph

### `archmap init [path]`

**What:** Walks the repo, parses source, writes `.archmap/index.db`, starter `seed.yaml`, `.mcp.json` if missing, gitignore lines, UI assets.

```bash
archmap init
archmap init ../some-repo
```

### `archmap summary`

**What:** Counts nodes by kind and lists the five most-connected symbols.

### `archmap explain [thing]` (alias: `symbol`)

**What:** One node, plus **CALLS** in and out, with file:line evidence.

```bash
archmap explain createItem
```

### `archmap impact [thing]` (alias: `what-happens`)

**What:** Bounded BFS on the graph (default depth 5): affected functions/APIs/tables/tests, why-paths, risk chips, severity. Human summary is LLM-narrated.

```bash
archmap impact createItem
archmap impact createItem --depth 3
archmap impact createItem --upstream
archmap impact createItem --json
```

### `archmap where-used [thing]` (aliases: `who-uses`, `neighbors`)

**What:** All **inbound** edges (calls, tests, contains, consumes, …).

### `archmap depends-on [thing]` (alias: `dependencies`)

**What:** All **outbound** edges.

### `archmap trace [from] [to]` (aliases: `why`, `why_path`)

**What:** Shortest evidence-backed paths between two nodes.

```bash
archmap trace createItem handleCreateItem
```

### `archmap tests [thing]` (alias: `tests_to_run`)

**What:** `Test` nodes on a short downstream impact path.

### `archmap flow [thing]`

**What:** Ordered steps from a start node with source evidence.

### `archmap search [query]`

**What:** Lexical search over indexed nodes.

```bash
archmap search catalog
archmap search createItem --limit 20
```

### `archmap map` (alias: `graph`)

**What:** Height-view Mermaid (services, APIs, datastores, packages).

```bash
archmap map
archmap map --json
```

### `archmap insights`

**What:** Cycles, high coupling, bottlenecks, hubs, isolated modules, hotspots, large downstream impact.

### `archmap health`

**What:** Consistency checks on the graph.

### `archmap docs [name]`

**What:** Indexed README / ADR / markdown near that component.

### `archmap pin`

**What:** Upserts one user-confirmed edge on the **same** graph.

```bash
archmap pin --from fn:apps/catalog/service.ts:createItem --to table:items --type WRITES
```

### `archmap plan_change [thing]`

**What:** Mutation envelope: allowed files, impacted IDs, tests, contracts, policy hits.

### `archmap diff [base] [head]`

**What:** Git-changed files → parse old vs new → symbols classified → union impact.

```bash
archmap diff                 # working tree + untracked vs HEAD
archmap diff --working
archmap diff --staged        # index vs HEAD
archmap diff main HEAD       # commit range
```

### `archmap analyze [path]` (alias: `sync`)

**What:** Full re-parse into the existing graph.

### `archmap status [path]`

**What:** Initialized?, counts, last journal events.

### `archmap add [path]`

**What:** Parses another tree and **merges** it into the current graph.

### `archmap ui`

**What:** Local D3 visualizer at [http://localhost:3743](http://localhost:3743).

```bash
archmap ui
archmap ui --port 3743
archmap ui --no-open
```

### `archmap serve`

**What:** HTTP daemon on **127.0.0.1:3742**.

### `archmap mcp`

**What:** MCP server on stdio.

### `archmap guide`

**What:** Prints the short in-CLI walkthrough.

---

## Agent commands

### `archmap orchestrate <task>`

**What:** Explore → impact → docs → tests → plan → policies → verify → review.

```bash
archmap orchestrate "what happens if I change createItem"
```

### `archmap route <task>`

**What:** Picks deterministic / cheap / strong / verifier.

### `archmap agent run <task>`

Same pipeline as `orchestrate`.

### `archmap agent verify`

**What:** Graph consistency + optional envelope.

```bash
archmap agent verify --target createItem --files apps/catalog/service.ts
```

### `archmap agent debate "<A>" "<B>"`

**What:** Scores proposals by cited graph IDs.

```bash
archmap agent debate "keep POST /items" "replace with an event"
```

### `archmap agent skill [name]`

**What:** One skill. No name → list.

```bash
archmap agent skill impact-analysis --id createItem
archmap agent skill code-review
```

### `archmap agent record`

**What:** Journals an incident/coverage/runtime event.

---

## JSON, MCP, HTTP

```bash
archmap impact createItem --json
archmap diff --staged --json
archmap orchestrate "impact of createItem" --json
```

**MCP tools:** `search`, `symbol`, `neighbors`, `blast_radius`, `diff_impact`, `why_path`, `docs_for`, `tests_to_run`, `health`, `plan_change`, `pin`, `insights`, `agent_run`, `agent_verify`, `agent_debate`, `agent_skill`, `record_event`

**HTTP** `POST http://127.0.0.1:3742/v1/<name>`

---

## Workspace files

```text
.archmap/
├── index.db         # SQLite graph
├── seed.yaml        # Optional services, pins, ignore_paths
├── journal.jsonl    # init / pin / agent events
├── agent-runs/      # orchestrate transcripts
├── public/          # local UI JS
└── cache/docs/
.mcp.json            # editor MCP stub
.env                 # LLM API key configuration
```

---

## Concepts

- **One graph.** Parser, git, docs, pins, agents, LLM all hit the same SQLite file.
- **Stable IDs.** `fn:apps/catalog/service.ts:createItem`, `api:POST:/items`, `table:items`
- **Evidence.** Edges carry file + line + snippet.
- **Bounded agents.** Allowed files, forbidden actions, token/time budget, verifier.
- **Local index.** DB stays on disk. The LLM sees compact names/snippets, not the whole repo.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `No indexed data. Run: archmap init` | Wrong cwd, or never inited |
| `Couldn't find "createItem"` | That name is not in this repo — use `summary` / `search` |
| Empty `archmap diff` | Not a git repo, or no changes vs HEAD |
| `impact` with no narration | No LLM configured — set API key in `.env` |
| `archmap chat` says "No LLM configured" | `.env` missing or wrong — check `ARCHMAP_LLM_API_KEY` |
| Chat agent runs too many tools | Normal — max 3 tools per round, 3 rounds max |
| UI is empty | `archmap ui` not started from the indexed repo |
| MCP cannot start | Use global `archmap mcp` for local install |
| `analyze` fails | No `.archmap/` yet — run `init` first |

---

## Project layout

```text
src/core/     Graph, impact, diff, plan, verify, agents
src/parse/    Multi-language parse → Core nodes/edges
src/cli/      archmap command
src/mcp/      stdio MCP
src/daemon/   localhost HTTP
src/ui/       Visualizer (D3.js)
src/llm/      LLM client, router, narration, chat agent
examples/catalog-platform/
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev -- summary
```
