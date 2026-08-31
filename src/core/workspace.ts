// Multi-repo workspace discovery.
// Finds git repos, monorepo structures, and cross-repo dependencies.
// Creates cross-repo edges in the ONE graph.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type { GraphNode, GraphEdge } from './types.js';
import { fileId, edgeId, repoId, packageId, externalId } from './ids.js';

export interface WorkspaceRepo {
  /** Absolute path to the repo root */
  root: string;
  /** Relative path from workspace root */
  relPath: string;
  /** Repo name (from directory or git remote) */
  name: string;
  /** Package name from package.json (if any) */
  packageName?: string;
  /** Version from package.json */
  version?: string;
  /** Languages detected */
  languages: string[];
  /** Whether this is the "main" repo */
  isMain: boolean;
}

export interface WorkspaceEdge {
  from: string;
  to: string;
  type: 'DEPENDS_ON' | 'IMPORTS' | 'CO_CHANGED';
  evidence: string;
  confidence: number;
}

export interface WorkspaceDiscovery {
  /** Workspace root directory */
  root: string;
  /** All repos found */
  repos: WorkspaceRepo[];
  /** Cross-repo edges */
  edges: WorkspaceEdge[];
  /** Monorepo structure (if detected) */
  monorepo?: {
    type: 'npm-workspaces' | 'turborepo' | 'nx' | 'lerna' | 'pnpm' | 'rush' | 'unknown';
    packages: string[];
  };
}

/**
 * Discover all git repos and monorepo packages in a directory tree.
 */
export function discoverWorkspace(
  rootPath: string,
  maxDepth = 4
): WorkspaceDiscovery {
  const repos: WorkspaceRepo[] = [];
  const edges: WorkspaceEdge[] = [];

  // 1. Find all .git directories
  const gitRepos = findGitRepos(rootPath, maxDepth);

  // 2. Detect monorepo structure
  const monorepo = detectMonorepo(rootPath);

  // 3. If monorepo, find all packages
  if (monorepo) {
    for (const pkgPath of monorepo.packages) {
      const absPath = join(rootPath, pkgPath);
      if (existsSync(absPath)) {
        const repo = analyzeRepo(absPath, rootPath, repos.length === 0);
        if (repo) repos.push(repo);
      }
    }
  }

  // 4. Add git repos not already found via monorepo
  for (const gitRoot of gitRepos) {
    const relPath = relative(rootPath, gitRoot).replace(/\\/g, '/');
    if (!repos.some(r => r.root === gitRoot)) {
      const repo = analyzeRepo(gitRoot, rootPath, repos.length === 0);
      if (repo) repos.push(repo);
    }
  }

  // 5. Add the root itself if it's a repo
  if (existsSync(join(rootPath, '.git')) || existsSync(join(rootPath, 'package.json'))) {
    if (!repos.some(r => r.root === rootPath)) {
      const repo = analyzeRepo(rootPath, rootPath, true);
      if (repo) repos.push(repo);
    }
  }

  // 6. Detect cross-repo edges
  const crossRepoEdges = detectCrossRepoEdges(repos, rootPath);
  edges.push(...crossRepoEdges);

  return { root: rootPath, repos, edges, monorepo: monorepo ?? undefined };
}

/**
 * Find all .git directories in the directory tree.
 */
function findGitRepos(rootPath: string, maxDepth: number): string[] {
  const repos: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    // Check if this directory is a git repo root
    if (existsSync(join(dir, '.git'))) {
      if (!repos.includes(dir)) {
        repos.push(dir);
      }
      return; // Don't recurse into git repos
    }

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.archmap') continue;

        const abs = join(dir, entry);
        try {
          if (statSync(abs).isDirectory()) {
            walk(abs, depth + 1);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  walk(rootPath, 0);
  return repos;
}

/**
 * Detect monorepo structure.
 */
function detectMonorepo(rootPath: string): WorkspaceDiscovery['monorepo'] | null {
  // Check for npm workspaces
  const pkgJsonPath = join(rootPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (pkg.workspaces) {
        const packages = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : pkg.workspaces.packages || [];
        return { type: 'npm-workspaces', packages };
      }
    } catch { /* skip */ }
  }

  // Check for turborepo
  if (existsSync(join(rootPath, 'turbo.json'))) {
    try {
      const turbo = JSON.parse(readFileSync(join(rootPath, 'turbo.json'), 'utf-8'));
      const packages = turbo.projects || turbo.packages || [];
      return { type: 'turborepo', packages };
    } catch { /* skip */ }
  }

  // Check for nx.json
  if (existsSync(join(rootPath, 'nx.json'))) {
    try {
      const nx = JSON.parse(readFileSync(join(rootPath, 'nx.json'), 'utf-8'));
      const packages = nx.projects || [];
      return { type: 'nx', packages: Array.isArray(packages) ? packages : Object.keys(packages) };
    } catch { /* skip */ }
  }

  // Check for lerna.json
  if (existsSync(join(rootPath, 'lerna.json'))) {
    try {
      const lerna = JSON.parse(readFileSync(join(rootPath, 'lerna.json'), 'utf-8'));
      const packages = lerna.packages || ['packages/*'];
      return { type: 'lerna', packages };
    } catch { /* skip */ }
  }

  // Check for pnpm-workspace.yaml
  if (existsSync(join(rootPath, 'pnpm-workspace.yaml'))) {
    try {
      const content = readFileSync(join(rootPath, 'pnpm-workspace.yaml'), 'utf-8');
      const packages = content.split('\n')
        .filter(l => l.includes(':'))
        .map(l => l.split(':')[1]?.trim().replace(/['"]/g, ''))
        .filter(Boolean) as string[];
      return { type: 'pnpm', packages };
    } catch { /* skip */ }
  }

  // Check for rush.json
  if (existsSync(join(rootPath, 'rush.json'))) {
    try {
      const rush = JSON.parse(readFileSync(join(rootPath, 'rush.json'), 'utf-8'));
      const packages = (rush.projects || []).map((p: any) => p.projectFolder || p.path);
      return { type: 'rush', packages };
    } catch { /* skip */ }
  }

  // Check for standard monorepo directories
  const monorepoDirs = ['packages', 'apps', 'services', 'libs', 'modules', 'workspaces'];
  const found: string[] = [];
  for (const dir of monorepoDirs) {
    const abs = join(rootPath, dir);
    if (existsSync(abs)) {
      try {
        const entries = readdirSync(abs);
        for (const entry of entries) {
          const entryAbs = join(abs, entry);
          if (statSync(entryAbs).isDirectory() && existsSync(join(entryAbs, 'package.json'))) {
            found.push(`${dir}/${entry}`);
          }
        }
      } catch { /* skip */ }
    }
  }

  if (found.length >= 2) {
    return { type: 'unknown', packages: found };
  }

  return null;
}

/**
 * Analyze a single repo/package.
 */
function analyzeRepo(
  absPath: string,
  workspaceRoot: string,
  isMain: boolean
): WorkspaceRepo | null {
  if (!existsSync(absPath)) return null;

  const relPath = relative(workspaceRoot, absPath).replace(/\\/g, '/') || '.';
  let name = basename(absPath);
  let packageName: string | undefined;
  let version: string | undefined;

  // Read package.json
  const pkgJsonPath = join(absPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      packageName = pkg.name;
      version = pkg.version;
      if (pkg.name) {
        // Use the package name (strip scope)
        name = pkg.name.split('/').pop() || name;
      }
    } catch { /* skip */ }
  }

  // Detect languages
  const languages = detectLanguages(absPath);

  return {
    root: absPath,
    relPath,
    name,
    packageName,
    version,
    languages,
    isMain,
  };
}

/**
 * Detect languages used in a repo.
 */
function detectLanguages(repoPath: string): string[] {
  const langs = new Set<string>();
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.java': 'java', '.go': 'go',
    '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
    '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin',
    '.scala': 'scala', '.cpp': 'cpp', '.c': 'c',
  };

  try {
    // Only scan top-level and one level deep — fast
    const entries = readdirSync(repoPath);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue;
      const abs = join(repoPath, entry);
      try {
        if (statSync(abs).isFile()) {
          const ext = '.' + entry.split('.').pop()?.toLowerCase();
          if (langMap[ext]) langs.add(langMap[ext]);
        } else if (statSync(abs).isDirectory()) {
          // One level deep
          try {
            const sub = readdirSync(abs);
            for (const s of sub.slice(0, 20)) {
              const sExt = '.' + s.split('.').pop()?.toLowerCase();
              if (langMap[sExt]) langs.add(langMap[sExt]);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return [...langs];
}

/**
 * Detect cross-repo edges by analyzing dependencies.
 */
function detectCrossRepoEdges(
  repos: WorkspaceRepo[],
  workspaceRoot: string
): WorkspaceEdge[] {
  const edges: WorkspaceEdge[] = [];

  // Build a map of package names to repo IDs
  const pkgToRepo = new Map<string, string>();
  for (const repo of repos) {
    if (repo.packageName) {
      pkgToRepo.set(repo.packageName, `repo:${repo.name}`);
    }
    pkgToRepo.set(repo.name, `repo:${repo.name}`);
  }

  // Check each repo's package.json dependencies — fast, no file scanning
  for (const repo of repos) {
    const pkgJsonPath = join(repo.root, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };

      for (const [depName] of Object.entries(allDeps)) {
        const targetRepoId = pkgToRepo.get(depName);
        if (targetRepoId && targetRepoId !== `repo:${repo.name}`) {
          edges.push({
            from: `repo:${repo.name}`,
            to: targetRepoId,
            type: 'DEPENDS_ON',
            evidence: `package.json dependency: ${depName}`,
            confidence: 0.95,
          });
        }
      }
    } catch { /* skip */ }
  }

  return edges;
}

/**
 * Convert workspace discovery results into graph nodes and edges.
 */
export function workspaceToGraph(
  discovery: WorkspaceDiscovery,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Create repo nodes
  for (const repo of discovery.repos) {
    const nodeId = `repo:${repo.name}`;
    nodes.push({
      id: nodeId,
      kind: 'Repo',
      name: repo.name,
      path: repo.relPath,
      updated_at: now,
      metadata: {
        root: repo.root,
        packageName: repo.packageName,
        version: repo.version,
        languages: repo.languages,
        isMain: repo.isMain,
        monorepo: discovery.monorepo?.type,
      },
    });
  }

  // Create cross-repo edges
  for (const wsEdge of discovery.edges) {
    // Only create edges between repos that exist as nodes
    const fromExists = nodes.some(n => n.id === wsEdge.from);
    const toExists = nodes.some(n => n.id === wsEdge.to);
    if (!fromExists || !toExists) continue;

    edges.push({
      id: edgeId(wsEdge.from, wsEdge.to, wsEdge.type),
      type: wsEdge.type,
      from: wsEdge.from,
      to: wsEdge.to,
      evidence: [{ file: 'workspace', line: 0, snippet: wsEdge.evidence }],
      sources: ['parser'],
      confidence: wsEdge.confidence,
      conflict: false,
      updated_at: now,
    });
  }

  return { nodes, edges };
}

/**
 * Get workspace summary for display.
 */
export function workspaceSummary(discovery: WorkspaceDiscovery): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${discovery.root}`);
  lines.push(`Repos: ${discovery.repos.length}`);

  if (discovery.monorepo) {
    lines.push(`Monorepo: ${discovery.monorepo.type}`);
    lines.push(`Packages: ${discovery.monorepo.packages.length}`);
  }

  lines.push('');
  for (const repo of discovery.repos) {
    const marker = repo.isMain ? ' ★' : '';
    const langs = repo.languages.length > 0 ? ` [${repo.languages.join(', ')}]` : '';
    const pkg = repo.packageName ? ` (${repo.packageName}@${repo.version || '?'})` : '';
    lines.push(`  ${repo.relPath}${marker}${pkg}${langs}`);
  }

  if (discovery.edges.length > 0) {
    lines.push('');
    lines.push(`Cross-repo edges: ${discovery.edges.length}`);
    for (const edge of discovery.edges) {
      const from = edge.from.replace('repo:', '');
      const to = edge.to.replace('repo:', '');
      lines.push(`  ${from} ──${edge.type}──▸ ${to}`);
    }
  }

  return lines.join('\n');
}
