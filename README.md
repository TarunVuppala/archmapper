# archmap

**Architecture Mapper** — one knowledge graph plus an AI agent layer for your codebase.

> **Question:** “If I change this piece of code, what else could be affected, and why?”

`archmap` indexes a repository into one local SQLite graph, then uses that graph **and an LLM** to explain structure, impact, flows, tests, docs, risks, and to run bounded agent workflows before you change code.

The parser and graph are the source of architectural truth. The model narrates, plans, debates, and hypothesizes from **names and snippets already in the graph**. It does not invent edges.

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

`npm i -g .` needs `dist/` (that is what `npm run build` creates). After this, `archmap` works from any directory.

### 2. Set the LLM key (required)

Default provider is **xAI**. Create a key at [https://console.x.ai](https://console.x.ai).

```powershell
# this terminal only (PowerShell)
$env:XAI_API_KEY = "xai-..."
```

```bash
export XAI_API_KEY=xai-...
```

The key must be in the **same terminal** as `archmap`. Closing the window drops a PowerShell `$env:` assignment. To persist on Windows: System Properties → Environment Variables, or `[System.Environment]::SetEnvironmentVariable('XAI_API_KEY','xai-...','User')` then open a **new** terminal.

| Setting | Default |
|---|---|
| Base URL | `https://api.x.ai/v1` |
| Strong model | `grok-4.6` (plan, orchestrate, debate, review) |
| Cheap model | `grok-4.3` (narration, summaries) |
| Timeout | `ARCHMAP_LLM_TIMEOUT_MS` = `20000` |

Other OpenAI-compatible hosts:

```bash
export ARCHMAP_LLM_API_KEY=...
export ARCHMAP_LLM_BASE_URL=https://your-host/v1
export ARCHMAP_LLM_MODEL=grok-4.6
export ARCHMAP_LLM_CHEAP_MODEL=grok-4.3
```

`ARCHMAP_LLM_API_KEY` wins if both keys are set.

### 3. Index a repository

```powershell
cd D:\path\to\the-repo-you-care-about
archmap init
```

Wait for node/edge counts. That writes `.archmap/` **in this folder**.

`archmap init ../other-repo` indexes *that* path, but the next command still uses **cwd**. After init, `cd` into the repo you indexed.

If you skip init: `No indexed data. Run: archmap init`.

After you change a lot of code, re-index:

```bash
archmap analyze          # alias: archmap sync
```

`analyze` needs an existing `.archmap/` (run `init` first).

### 4. Find something, then ask

You rarely know IDs up front. Use this order:

```bash
archmap summary                 # what's in the graph
archmap search catalog          # find by name
archmap explain                 # omit the name → numbered picker
archmap impact createItem
archmap diff                    # uncommitted git changes vs HEAD
archmap ui                      # http://localhost:3743
```

Names are whatever exists **in that repo**. `createItem` is from the bundled example, not from every clone.

You can pass a short name (`createItem`) or a stable ID (`fn:apps/catalog/service.ts:createItem`).

### 5. Ask the agent (still in the indexed repo)

```bash
archmap orchestrate "what happens if I change createItem"
archmap plan_change createItem
archmap agent verify --target createItem
```

### Try the bundled example first

```powershell
cd D:\code\archmapper
npm install; npm run build; npm i -g .
$env:XAI_API_KEY = "xai-..."

cd examples\catalog-platform
archmap init
archmap summary
archmap explain createItem
archmap impact createItem
archmap trace createItem handleCreateItem
archmap orchestrate "what happens if I change createItem"
archmap ui
```

That sample has `createItem` / `getItem`, `handleCreateItem`, `POST /items`, table `items`, and event `item.created`.

---

## Which command when

| You want to… | Run |
|---|---|
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
- Git — only required for `archmap diff` (and only if that folder is a git repo)
- LLM API key — required for narration, orchestrate, debate, review

```bash
node --version
npm --version
git --version
```

**Languages indexed:** TypeScript/JavaScript, Python, Java, Go, Rust, Ruby, PHP, C#, Swift, Kotlin, Scala, C/C++, plus manifests (`package.json`, `go.mod`, `Cargo.toml`, `pom.xml`, Gradle, `Gemfile`, `composer.json`, `requirements.txt`, `pyproject.toml`) and SQL/Prisma/OpenAPI-ish config when present. Unsupported languages still get files; call-graph depth is richest for TS/JS, Python, and Java.

---

## Commands

Most `[thing]` arguments open a numbered picker if omitted. `--json` prints the canonical envelope (for scripts, MCP, CI). `--json` on `impact` is the raw graph result — it does **not** call the LLM.

### `archmap init [path]`

**What:** Walks the repo, parses source, writes `.archmap/index.db`, starter `seed.yaml`, `.mcp.json` if missing, gitignore lines, UI assets.

**Why:** Nothing else works until this exists. Run once per repo (or when you want a full rebuild).

```bash
archmap init
archmap init ../some-repo     # writes that repo's .archmap/ — then cd there
```

### `archmap summary`

**What:** Counts nodes by kind (functions, APIs, tables, …) and lists the five most-connected symbols.

**Why:** First look at an unfamiliar codebase. Use it to pick names for `explain` / `impact`.

### `archmap explain [thing]`  (alias: `symbol`)

**What:** One node, plus **CALLS** in and out, with file:line evidence.

**Why:** “What is this, who uses it, what does it call?” — neighborhood only, not blast radius.

```bash
archmap explain createItem
```

### `archmap impact [thing]`  (alias: `what-happens`)

**What:** Bounded BFS on the graph (default depth 5): affected functions/APIs/tables/tests, why-paths, risk chips, severity. Human summary is LLM-narrated from graph names only.

**Why:** Before you edit. This is the product’s main question.

```bash
archmap impact createItem
archmap impact createItem --depth 3
archmap impact createItem --upstream    # what it depends on, not what depends on it
archmap impact createItem --json
```

### `archmap where-used [thing]`  (aliases: `who-uses`, `neighbors`)

**What:** All **inbound** edges (calls, tests, contains, consumes, …).

**Why:** “Who depends on this?” Broader than `explain`’s CALLS-only callers.

### `archmap depends-on [thing]`  (alias: `dependencies`)

**What:** All **outbound** edges.

**Why:** “What does this need to run?” (callees, tables, APIs, imports).

### `archmap trace [from] [to]`  (aliases: `why`, `why_path`)

**What:** Shortest evidence-backed paths between two nodes.

**Why:** When impact says B is affected and you want the chain, not the whole radius.

```bash
archmap trace createItem handleCreateItem
```

### `archmap tests [thing]`  (alias: `tests_to_run`)

**What:** `Test` nodes on a short downstream impact path. JSON also has `command: "npm test"` when any exist.

**Why:** What to run after you touch that symbol. Empty means the graph has no TESTS edges — not that the repo has no tests.

### `archmap flow [thing]`

**What:** Ordered steps from a start node (calls, exposes, writes, events) with source evidence.

**Why:** A readable story (`createItem` → validate → write → event), not a bag of neighbors.

### `archmap search [query]`

**What:** Lexical search over indexed nodes.

**Why:** You remember a word (`catalog`, `items`) but not the symbol.

```bash
archmap search catalog
archmap search createItem --limit 20
```

No query → picker.

### `archmap map`  (alias: `graph`)

**What:** Height-view Mermaid (services, APIs, datastores, packages — not every file).

**Why:** Paste into a PR or notes. For interaction use `ui`.

```bash
archmap map
archmap map --json
```

### `archmap insights`

**What:** Cycles, high coupling, bottlenecks, hubs, isolated modules, hotspots, large downstream impact.

**Why:** Architecture health, not “what happens if I change X”.

### `archmap health`

**What:** Consistency checks on the graph (empty graph, dangling edges, …).

**Why:** After init/sync, or when results look wrong.

### `archmap docs [name]`

**What:** Indexed README / ADR / markdown near that component.

**Why:** In-repo documentation without leaving the CLI. (LLM summary of those docs happens in `orchestrate` / `agent skill docs-resolution`, not in this command.)

### `archmap pin`

**What:** Upserts one user-confirmed edge on the **same** graph (`sources: [user]`).

**Why:** Parser missed a consumer, or you accepted an agent hypothesis. This is not a second “pins” database.

```bash
archmap pin --from fn:apps/catalog/service.ts:createItem --to table:items --type WRITES
```

Edge types: `CONTAINS`, `IMPORTS`, `CALLS`, `IMPLEMENTS`, `EXPOSES`, `CONSUMES`, `READS`, `WRITES`, `PUBLISHES`, `SUBSCRIBES`, `TESTS`, `DEPENDS_ON`, `DOCUMENTS`, `CONSTRAINED_BY`, `CO_CHANGED`, `BROKE_BEFORE`, `USES_CONFIG`.

### `archmap plan_change [thing]`

**What:** Mutation envelope: allowed files, impacted IDs, tests, contracts, policy hits, required evidence.

**Why:** Give an agent (or yourself) a fence before editing. `agent verify` checks later edits against this list.

### `archmap diff [base] [head]`

**What:** Git-changed files → parse old vs new → symbols classified `added` / `removed` / `signature_changed` / `body_only` → union impact.

**Why:** “I already edited (or have a PR). What did that do architecturally?” Needs a git repo.

```bash
archmap diff                 # working tree + untracked vs HEAD
archmap diff --working
archmap diff --staged        # index vs HEAD
archmap diff main HEAD       # commit range
```

Default with no refs is the working tree, not `main...HEAD`.

### `archmap analyze [path]`  (alias: `sync`)

**What:** Full re-parse into the existing graph (replaces nodes/edges, keeps the db file).

**Why:** After large edits. Surgical file-save sync is not a separate command — this is the reindex.

### `archmap status [path]`

**What:** Initialized?, counts, last journal events. Can point at another path.

**Why:** Quick “is this folder indexed?”

### `archmap add [path]`

**What:** Parses another tree and **merges** it into the **current** graph (does not wipe).

**Why:** Sibling repos / related services. You must already have `init` in cwd.

```bash
archmap add ../another-repo
```

### `archmap ui`

**What:** Local D3 visualizer. Default [http://localhost:3743](http://localhost:3743). Opens a browser unless `--no-open`.

**Why:** Click around the same graph the CLI uses.

```bash
archmap ui
archmap ui --port 3743
archmap ui --no-open
```

Run it from the indexed repo so it finds `.archmap/index.db`.

### `archmap serve`

**What:** HTTP daemon on **127.0.0.1:3742**. `POST /v1/<operation>` with JSON. Port is stored in `.archmap/daemon.json`.

**Why:** Scripts or another process that should not spawn a CLI each time.

### `archmap mcp`

**What:** MCP server on stdio (same tools as CLI JSON).

**Why:** Wire Cursor / other agents. `init` writes `.mcp.json` using `npx -y archmap mcp`. That works after a publish; with a **local global install**, point MCP at `archmap` / `mcp` instead, and set `cwd` to the indexed repo.

### `archmap guide`

**What:** Prints the short in-CLI walkthrough.

---

## Agent commands

Every run has a role, prompt contract, budget, and independent verification. Model text is provisional until graph checks pass. Hypotheses are **not** written as edges until you `pin`.

### `archmap orchestrate <task>`

**What:** Explore → impact → docs → tests → plan → policies → verify → review. LLM synthesizes a change-safety brief from payload names; may propose hidden coupling if the snippet exists on disk.

**Why:** One command instead of running the skills yourself. Writes `.archmap/agent-runs/<id>.json` and a journal line.

```bash
archmap orchestrate "what happens if I change createItem"
```

If it cannot resolve a target, it asks up to three questions instead of guessing.

### `archmap route <task>`

**What:** Picks deterministic / cheap / strong / verifier. No graph writes, no model call.

**Why:** See what would be billed before you orchestrate.

### `archmap agent run <task>`

Same pipeline as `orchestrate` (shorter human output).

### `archmap agent verify`

**What:** Graph consistency + optional envelope (`--target` builds a plan; `--files` must sit inside it; `--claims` must be real node IDs). Failure = **BLOCKED**.

**Why:** Independent check after an agent (or human) edited.

```bash
archmap agent verify --target createItem --files apps/catalog/service.ts
archmap agent verify --claims fn:apps/catalog/service.ts:createItem
```

### `archmap agent debate "<A>" "<B>"`

**What:** Scores proposals by cited graph IDs; LLM critique if the key is set.

**Why:** Two design options; do not want a vibe winner.

```bash
archmap agent debate "keep POST /items" "replace with an event"
```

Cite IDs in the text (`api:POST:/items`) or the graph cannot verify the claim.

### `archmap agent skill [name]`

**What:** One skill. No name → list.

```bash
archmap agent skill
archmap agent skill impact-analysis --id createItem
archmap agent skill code-review
archmap agent skill docs-resolution --id createItem
```

| Skill | Why |
|---|---|
| `impact-analysis` | Blast radius + narration |
| `repository-exploration` | Search + insights |
| `docs-resolution` | Docs + LLM summary of retrieved text |
| `change-planning` | Envelope |
| `safe-implementation` | Same envelope; **does not write files** |
| `code-review` | Working-tree diff vs graph/policies |
| `graph-verification` | Consistency |
| `test-selection` | Tests on the path |
| `contract-check` | Built-in policy warnings |
| `prompt-review` | Critique a prompt; never applies it |
| `cost-routing` | Tier choice |

### `archmap agent record`

**What:** Journals an incident/coverage/runtime event. With `--from` and `--to`, upserts `BROKE_BEFORE` on the same graph.

```bash
archmap agent record --kind incident --from fn:apps/catalog/service.ts:createItem --to table:items --message "timeout on write"
```

---

## JSON, MCP, HTTP

```bash
archmap impact createItem --json
archmap diff --staged --json
archmap orchestrate "impact of createItem" --json
```

**MCP tools:** `search`, `symbol`, `neighbors`, `blast_radius`, `diff_impact`, `why_path`, `docs_for`, `tests_to_run`, `health`, `plan_change`, `pin`, `insights`, `agent_run`, `agent_verify`, `agent_debate`, `agent_skill`, `record_event`

**HTTP** `POST http://127.0.0.1:3742/v1/<name>` — those plus `orchestrate`, `route`, `flow`, `view`

```json
{ "mode": "working" }
{ "mode": "staged" }
{ "mode": "range", "base": "main", "head": "HEAD" }
{ "task": "what happens if I change createItem" }
```

---

## Workspace files

Created in the **analyzed** repo (not in the archmap source tree, unless you indexed that):

```text
.archmap/
├── index.db         # SQLite graph — source of architectural truth
├── seed.yaml        # Optional services, pins, ignore_paths, critical IDs
├── journal.jsonl    # init / pin / agent events
├── agent-runs/      # orchestrate transcripts (journal, not a second graph)
├── public/          # local UI JS
└── cache/docs/
.mcp.json            # editor MCP stub
```

`seed.yaml` is for when the parser is blind (service ownership, extra pins). After load it is upserted into the graph.

---

## Concepts

- **One graph.** Parser, git, docs, pins, agents, LLM all hit the same SQLite file.
- **Stable IDs.** `fn:apps/catalog/service.ts:createItem`, `api:POST:/items`, `table:items`
- **Evidence.** Edges carry file + line + snippet.
- **Bounded agents.** Allowed files, forbidden actions, token/time budget, verifier. Failed verification blocks.
- **Local index.** DB stays on disk. The LLM sees compact names/snippets, not the whole repo.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `No indexed data. Run: archmap init` | Wrong cwd, or never inited |
| `Couldn't find "createItem"` | That name is not in **this** repo — `summary` / `search` / picker |
| Empty `archmap diff` | Not a git repo, or no changes vs HEAD |
| `impact` / `orchestrate` with no narration | `XAI_API_KEY` not set **in this terminal** |
| UI is empty / wrong project | `archmap ui` not started from the indexed repo |
| MCP cannot start | `.mcp.json` uses `npx -y archmap`; use the global `archmap mcp` for a local install |
| `analyze` fails | No `.archmap/` yet — `init` first |
| Tests command is empty | No `TESTS` edges in the graph, even if test files exist |

---

## Project layout (this repo)

```text
src/core/     Graph, impact, diff, plan, verify, agents
src/parse/    Multi-language parse → Core nodes/edges
src/cli/      archmap command
src/mcp/      stdio MCP
src/daemon/   localhost HTTP
src/ui/       Visualizer
src/llm/      xAI-default client, router, narration
examples/catalog-platform/
```

## Development of archmap itself

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev -- summary          # cwd must already have .archmap/
```
