// Git co-change detection.
// Analyzes git history to find files that frequently change together
// and creates CO_CHANGED edges in the graph.

import { execSync } from 'node:child_process';
import type { GraphEdge } from '../core/types.js';
import { edgeId, fileId } from '../core/ids.js';

interface CoChangePair {
  fileA: string;
  fileB: string;
  count: number;
}

/**
 * Find files that frequently change together in git history.
 * Uses `git log --name-only` to detect co-changes.
 */
export function detectCoChanges(
  repoPath: string,
  relativeFiles: string[],
  now: string,
  options: { maxCommits?: number; minCoChanges?: number } = {}
): GraphEdge[] {
  const { maxCommits = 200, minCoChanges = 3 } = options;
  const edges: GraphEdge[] = [];

  // Get commit history with changed files
  let logOutput: string;
  try {
    logOutput = execSync(
      `git log --pretty=format:COMMIT_%H --name-only -${maxCommits}`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
  } catch {
    return edges; // Not a git repo or no history
  }

  // Parse commits and their changed files
  const commits: string[][] = [];
  let currentCommit: string[] = [];

  for (const line of logOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('COMMIT_')) {
      if (currentCommit.length >= 2) {
        commits.push(currentCommit);
      }
      currentCommit = [];
    } else if (trimmed) {
      currentCommit.push(trimmed);
    }
  }
  if (currentCommit.length >= 2) {
    commits.push(currentCommit);
  }

  // Count co-changes
  const pairCounts = new Map<string, CoChangePair>();
  const fileSet = new Set(relativeFiles);

  for (const commit of commits) {
    // Only consider files that are in our graph
    const tracked = commit.filter(f => fileSet.has(f));
    if (tracked.length < 2 || tracked.length > 15) continue;

    // Create pairs
    for (let i = 0; i < tracked.length; i++) {
      for (let j = i + 1; j < tracked.length; j++) {
        const [a, b] = tracked[i] < tracked[j] ? [tracked[i], tracked[j]] : [tracked[j], tracked[i]];
        const key = `${a}|${b}`;
        const existing = pairCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          pairCounts.set(key, { fileA: a, fileB: b, count: 1 });
        }
      }
    }
  }

  // Create CO_CHANGED edges for pairs that meet the threshold
  for (const pair of pairCounts.values()) {
    if (pair.count >= minCoChanges) {
      const fromId = fileId(pair.fileA);
      const toId = fileId(pair.fileB);
      const confidence = Math.min(1.0, pair.count / 10);

      edges.push({
        id: edgeId(fromId, toId, 'CO_CHANGED'),
        type: 'CO_CHANGED',
        from: fromId,
        to: toId,
        evidence: [{
          file: pair.fileA,
          line: 1,
          snippet: `Co-changed ${pair.count} times with ${pair.fileB}`,
        }],
        sources: ['git'],
        confidence,
        conflict: false,
        updated_at: now,
        metadata: { coChangeCount: pair.count },
      });
    }
  }

  return edges;
}

/**
 * Get file churn (change frequency) from git history.
 * Returns a map of file path → number of commits touching it.
 */
export function getFileChurn(
  repoPath: string,
  maxCommits = 200
): Map<string, number> {
  const churn = new Map<string, number>();

  try {
    const output = execSync(
      `git log --pretty=format: --name-only -${maxCommits}`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    for (const line of output.split('\n')) {
      const file = line.trim();
      if (file) {
        churn.set(file, (churn.get(file) || 0) + 1);
      }
    }
  } catch {
    // Not a git repo
  }

  return churn;
}
