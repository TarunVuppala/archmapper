# archmap

**Architecture Mapper** — one knowledge graph for your codebase.

> **Question:** “If I change this piece of code, what else could be affected, and why?”

`archmap` is a local CLI that analyzes a repository, builds an architecture/dependency graph, and provides commands for understanding structure, dependencies, impact, execution flow, tests, documentation, architecture risks, and change planning.

## Requirements

- Node.js **22.5+**
- npm
- Git

Check your versions:

```bash
node --version
npm --version
git --version
```

## Installation

From the `archmap` project directory:

```bash
npm i -g .
```

Verify the installation:

```bash
archmap --version
archmap --help
```

## Analyze a repository

Clone the repository you want to analyze:

```bash
git clone <REPOSITORY_URL>
cd <REPOSITORY_FOLDER>
```

Initialize `archmap`:

```bash
archmap init
```

`init` analyzes the repository, builds the architecture/dependency graph, and creates the local `.archmap/` workspace.

After initialization, use the commands below to explore the repository.

## Commands

### `archmap init [path]`

Analyze a repository and create/update its `.archmap/` workspace.

```bash
archmap init
archmap init ../some-repo
```

### `archmap summary`

Show a high-level summary of the analyzed codebase.

```bash
archmap summary
```

Shows code pieces, graph connections, node types, and highly connected functions, methods, or classes.

### `archmap explain [thing]`

Show information about a component, including what calls it and what it calls.

```bash
archmap explain createItem
```

Alias:

```bash
archmap symbol createItem
```

Running without a name opens an interactive picker.

### `archmap impact [thing]`

Show the downstream impact of changing a component.

```bash
archmap impact createItem
```

Options:

```bash
archmap impact createItem --depth 3
archmap impact createItem --upstream
archmap impact createItem --json
```

Alias:

```bash
archmap what-happens createItem
```

### `archmap where-used [thing]`

Find code that uses or calls a component.

```bash
archmap where-used createItem
```

Aliases:

```bash
archmap who-uses createItem
archmap neighbors createItem
```

### `archmap depends-on [thing]`

Show the direct dependencies of a component.

```bash
archmap depends-on createItem
```

Alias:

```bash
archmap dependencies createItem
```

### `archmap trace [from] [to]`

Show paths between two components using the relationships in the graph.

```bash
archmap trace createItem createItemRoute
```

Aliases:

```bash
archmap why <from> <to>
archmap why_path <from> <to>
```

### `archmap tests [thing]`

Find tests connected to a component through the analyzed graph.

```bash
archmap tests createItem
```

Alias:

```bash
archmap tests_to_run createItem
```

When test nodes are found, the JSON response also provides the inferred test command.

### `archmap flow [thing]`

Reconstruct an execution flow starting from a component.

```bash
archmap flow createItem
```

The output includes the ordered flow and available source-file evidence.

### `archmap search [query]`

Search the indexed architecture and code graph.

```bash
archmap search catalog
archmap search database
archmap search createItem --limit 20
```

### `archmap map`

Generate an architecture overview as Mermaid.

```bash
archmap map
```

Alias:

```bash
archmap graph
```

Options:

```bash
archmap map --format mermaid
archmap map --max-nodes 100
archmap map --json
```

### `archmap health`

Check the health and consistency of the generated graph.

```bash
archmap health
```

JSON output:

```bash
archmap health --json
```

### `archmap pin`

Add a user-confirmed relationship between two graph nodes.

```bash
archmap pin --from <id> --to <id> --type DEPENDS_ON
```

The relationship is recorded in the journal.

### `archmap analyze [path]`

Re-scan an already initialized repository.

```bash
archmap analyze
```

Alias:

```bash
archmap sync
```

### `archmap insights`

Show architecture-level signals such as circular dependencies, highly coupled components, bottlenecks, hubs, isolated components, hotspots, and components with large downstream impact.

```bash
archmap insights
```

JSON output:

```bash
archmap insights --json
```

### `archmap plan_change [thing]`

Generate a bounded change plan around a component.

```bash
archmap plan_change createItem
```

The result includes affected nodes, relevant files, and tests where available.

### `archmap diff [base] [head]`

Analyze the impact of a Git diff.

```bash
archmap diff
archmap diff main HEAD
```

This resolves changed symbols where possible and combines the changes with graph impact analysis.

The repository must be a Git repository with the requested revisions available.

### `archmap docs [name]`

Find repository documentation related to a component or package.

```bash
archmap docs createItem
```

The command searches indexed README, ADR, and other documentation content.

### `archmap status [path]`

Show whether a repository has been initialized and summarize its current analysis.

```bash
archmap status
archmap status ../some-repo
```

### `archmap add [path]`

Add another repository to the current graph without replacing the existing graph.

```bash
archmap add ../another-repo
```

### `archmap ui`

Start the local browser-based visualizer.

```bash
archmap ui
```

Default port:

```text
http://localhost:3743
```

Options:

```bash
archmap ui --port 3743
archmap ui --no-open
```

Press `Ctrl+C` to stop the UI.

### `archmap serve`

Start the optional local HTTP daemon/API.

```bash
archmap serve
```

Default port:

```text
3742
```

Custom port:

```bash
archmap serve --port 4000
```

### `archmap mcp`

Start the MCP server over stdio for AI/editor integration.

```bash
archmap mcp
```

`archmap init` also creates `.mcp.json` when it does not already exist.

### `archmap guide`

Print a first-time walkthrough of the CLI.

```bash
archmap guide
```

## JSON output

Many analysis commands support `--json` for scripts, agents, and CI workflows.

Examples:

```bash
archmap summary --json
archmap explain createItem --json
archmap impact createItem --json
archmap search catalog --json
archmap map --json
archmap health --json
archmap insights --json
archmap plan_change createItem --json
archmap diff main HEAD --json
archmap status --json
```

## Generated `.archmap/` workspace

After initialization, the analyzed repository contains a local `.archmap/` workspace:

```text
.archmap/
├── index.db       # SQLite architecture graph
├── seed.yaml      # Optional project metadata / user corrections
├── journal.jsonl  # Append-only event history
└── cache/         # Local analysis/document cache
```

`archmap` may also create:

```text
.mcp.json
```

for MCP/editor integration.

Generated runtime data is added to `.gitignore` where appropriate.

## Included example

A small example repository is included at:

```text
examples/catalog-platform/
```

It can be used to explore the tool without cloning an external project.

## Project structure

```text
archmapper-main/
├── src/
│   ├── core/       # Graph store, impact, diff, flow, insights, plans, docs, health, journal
│   ├── parse/      # Repository/source parsing
│   ├── cli/        # Command-line interface
│   ├── mcp/        # MCP server
│   ├── daemon/     # Optional HTTP server
│   ├── ui/         # Local visualizer
│   └── llm/        # Optional narration-related code
├── test/            # Core tests
├── examples/        # Example repository
├── .archmap/        # Local project metadata/sample state
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── AGENTS.md
└── README.md
```

## Core concepts

### One graph

The project maintains a SQLite-backed graph containing nodes and relationships used by the CLI analysis features.

### Evidence-backed relationships

Graph relationships can retain source-file, line, and snippet evidence so that impact and path results can be traced back to code.

### Stable identifiers

Nodes use identifiers such as:

```text
fn:src/app.ts:main
api:POST:/items
table:users
```

### Local analysis

The main graphing and analysis workflow runs locally and does not require an LLM or paid API.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run type checking:

```bash
npm run typecheck
```

Build the package:

```bash
npm run build
```

Run directly from TypeScript during development:

```bash
npm run dev -- summary
```

## Typical workflow

```bash
# Install archmap
npm i -g .

# Clone a repository
git clone <REPOSITORY_URL>
cd <REPOSITORY_FOLDER>

# Analyze it
archmap init

# Explore the codebase
archmap summary
archmap search <keyword>
archmap explain <name>

# Explore relationships
archmap where-used <name>
archmap depends-on <name>
archmap trace <from> <to>
archmap flow <name>

# Check change impact
archmap impact <name>
archmap tests <name>
archmap plan_change <name>

# Visualize the architecture
archmap map
archmap ui
```
