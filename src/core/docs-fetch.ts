// External docs fetcher.
// Resolves official docs for npm packages and external dependencies.
// Uses lockfile version for import, fetches README/changelog.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphNode, GraphEdge } from './types.js';
import { docId, externalId, edgeId } from './ids.js';

interface PackageInfo {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  repository?: string;
  readme?: string;
}

/**
 * Get package version from lockfile or package.json.
 */
function getPackageVersion(repoPath: string, pkgName: string): string | null {
  // Try package.json first
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
    const version = pkg.dependencies?.[pkgName] || pkg.devDependencies?.[pkgName];
    if (version) {
      // Strip version prefix (^, ~, >=, etc.)
      return version.replace(/^[^\d]*/, '');
    }
  } catch { /* skip */ }

  // Try npm ls
  try {
    const output = execSync(`npm ls ${pkgName} --depth=0 2>/dev/null`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    const match = output.match(new RegExp(`${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([\\d.]+)`));
    if (match) return match[1];
  } catch { /* skip */ }

  return null;
}

/**
 * Fetch npm package metadata (description, homepage, etc.)
 */
function fetchNpmInfo(pkgName: string): PackageInfo | null {
  try {
    const output = execSync(`npm info ${pkgName} --json 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const info = JSON.parse(output);
    return {
      name: info.name || pkgName,
      version: info.version || 'latest',
      description: info.description,
      homepage: info.homepage,
      repository: (info.repository && typeof info.repository === 'object') ? info.repository.url : info.repository,
      readme: info.readme,
    };
  } catch {
    return null;
  }
}

/**
 * Create Doc nodes for external packages.
 */
export function fetchExternalDocs(
  repoPath: string,
  externalNodes: GraphNode[],
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cacheDir = join(repoPath, '.archmap', 'cache', 'docs');

  // Ensure cache directory exists
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // Process each external dependency
  const processed = new Set<string>();

  for (const ext of externalNodes) {
    const pkgName = ext.id.replace('ext:', '');
    if (processed.has(pkgName)) continue;
    processed.add(pkgName);

    // Skip non-npm packages (e.g., internal service references)
    if (pkgName.startsWith('/') || pkgName.includes('://')) continue;

    // Get version from lockfile
    const version = getPackageVersion(repoPath, pkgName);

    // Check cache
    const cacheKey = `${pkgName}@${version || 'latest'}`;
    const cacheFile = join(cacheDir, `${pkgName.replace(/[/@]/g, '_')}.json`);

    let info: PackageInfo | null = null;

    if (existsSync(cacheFile)) {
      try {
        info = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      } catch { /* re-fetch */ }
    }

    if (!info) {
      info = fetchNpmInfo(pkgName);
      if (info) {
        // Cache the result
        try {
          writeFileSync(cacheFile, JSON.stringify(info, null, 2), 'utf-8');
        } catch { /* skip */ }
      }
    }

    if (!info) continue;

    // Create Doc node for the package
    const docNodeId = `doc:npm:${pkgName}`;
    nodes.push({
      id: docNodeId,
      kind: 'Doc',
      name: `${pkgName} docs`,
      path: info.homepage || `npm:${pkgName}`,
      updated_at: now,
      metadata: {
        type: 'npm_package',
        version: version || info.version,
        description: info.description,
        homepage: info.homepage,
        repository: info.repository,
      },
    });

    // Link external node to doc
    const extId = ext.id;
    edges.push({
      id: edgeId(extId, docNodeId, 'DOCUMENTS'),
      type: 'DOCUMENTS',
      from: extId,
      to: docNodeId,
      evidence: [{
        file: 'package.json',
        line: 1,
        snippet: `${pkgName}@${version || info.version}`,
      }],
      sources: ['lockfile'],
      confidence: 1.0,
      conflict: false,
      updated_at: now,
    });

    // If we have a readme, create a summary doc
    if (info.readme && info.readme.length > 50) {
      const readmeDocId = `doc:npm:${pkgName}:readme`;
      const excerpt = info.readme.slice(0, 500).replace(/\n+/g, ' ').trim();

      nodes.push({
        id: readmeDocId,
        kind: 'Doc',
        name: `${pkgName} README`,
        path: info.homepage || `npm:${pkgName}`,
        updated_at: now,
        metadata: {
          type: 'npm_readme',
          excerpt,
        },
      });

      edges.push({
        id: edgeId(docNodeId, readmeDocId, 'CONTAINS'),
        type: 'CONTAINS',
        from: docNodeId,
        to: readmeDocId,
        evidence: [],
        sources: ['lockfile'],
        confidence: 0.9,
        conflict: false,
        updated_at: now,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Find in-repo documentation files (README, ADR, llms.txt, etc.)
 */
export function findInRepoDocs(
  repoPath: string,
  relativeFiles: string[],
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const docPatterns = [
    /readme/i,
    /adr/i,
    /design/i,
    /architecture/i,
    /changelog/i,
    /contributing/i,
    /llms\.txt/i,
    /\.md$/i,
  ];

  for (const file of relativeFiles) {
    const isDoc = docPatterns.some(p => p.test(file));
    if (!isDoc) continue;

    const docNodeId = `doc:${file}`;
    const name = file.split('/').pop() || file;

    nodes.push({
      id: docNodeId,
      kind: 'Doc',
      name,
      path: file,
      updated_at: now,
    });

    // Try to extract content for linking
    try {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const lines = content.split('\n').slice(0, 50); // First 50 lines

      // Look for references to code components
      for (const line of lines) {
        const fnRef = line.match(/`(\w+)`/g);
        if (fnRef) {
          for (const ref of fnRef) {
            const name = ref.replace(/`/g, '');
            // This is a rough heuristic — we'll let the graph resolve actual links
          }
        }
      }
    } catch { /* skip */ }
  }

  return { nodes, edges };
}
