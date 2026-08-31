// Incremental sync with content hashing.
// Only re-parses files that have changed since last sync,
// dramatically speeding up `archmap sync` on large repos.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface FileHash {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface HashManifest {
  version: 1;
  generatedAt: string;
  files: Record<string, FileHash>;
}

/**
 * Compute SHA-256 hash of file content.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Load the previous hash manifest from disk.
 */
export function loadManifest(repoPath: string): HashManifest {
  const manifestPath = join(repoPath, '.archmap', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { version: 1, generatedAt: '', files: {} };
  }
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { version: 1, generatedAt: '', files: {} };
  }
}

/**
 * Save the hash manifest to disk.
 */
export function saveManifest(repoPath: string, manifest: HashManifest): void {
  const dir = join(repoPath, '.archmap');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Compute hashes for all tracked files.
 */
export function computeCurrentHashes(
  repoPath: string,
  files: string[]
): Map<string, FileHash> {
  const hashes = new Map<string, FileHash>();

  for (const relPath of files) {
    const abs = join(repoPath, relPath);
    try {
      const content = readFileSync(abs, 'utf-8');
      hashes.set(relPath, {
        path: relPath,
        hash: contentHash(content),
        size: content.length,
        mtime: Date.now(),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return hashes;
}

/**
 * Compare current hashes against manifest to find changed files.
 * Returns { changed, added, removed } lists.
 */
export function diffManifests(
  previous: HashManifest,
  current: Map<string, FileHash>
): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Find changed and added files
  for (const [path, hash] of current) {
    const prev = previous.files[path];
    if (!prev) {
      added.push(path);
    } else if (prev.hash !== hash.hash) {
      changed.push(path);
    }
  }

  // Find removed files
  for (const path of Object.keys(previous.files)) {
    if (!current.has(path)) {
      removed.push(path);
    }
  }

  return { changed, added, removed };
}

/**
 * Get the list of files that need re-parsing.
 * Combines new files, changed files, and files that import changed files.
 */
export function getFilesToReparse(
  repoPath: string,
  diff: { changed: string[]; added: string[]; removed: string[] },
  allFiles: string[]
): string[] {
  const toReparse = new Set<string>([...diff.changed, ...diff.added]);

  // Also re-parse files that import changed files
  // (simple heuristic: if a file imports a changed file, re-parse it too)
  if (diff.changed.length > 0 || diff.added.length > 0) {
    const changedBasenames = new Set(
      [...diff.changed, ...diff.added].map(f => f.split('/').pop()?.replace(/\.[^.]+$/, '') || '')
    );

    for (const file of allFiles) {
      if (toReparse.has(file)) continue;
      try {
        const content = readFileSync(join(repoPath, file), 'utf-8');
        for (const base of changedBasenames) {
          if (base && content.includes(base)) {
            toReparse.add(file);
            break;
          }
        }
      } catch {
        // skip
      }
    }
  }

  return [...toReparse];
}

/**
 * Update manifest after a successful sync.
 */
export function updateManifest(
  previous: HashManifest,
  current: Map<string, FileHash>,
  removedFiles: string[]
): HashManifest {
  const files = { ...previous.files };

  // Add/update current files
  for (const [path, hash] of current) {
    files[path] = hash;
  }

  // Remove deleted files
  for (const path of removedFiles) {
    delete files[path];
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
  };
}
