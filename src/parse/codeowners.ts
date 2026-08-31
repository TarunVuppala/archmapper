// CODEOWNERS parser.
// Reads GitHub CODEOWNERS file and provides suggested reviewers
// for files based on ownership patterns.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeOwner {
  pattern: string;
  owners: string[];
  line: number;
}

/**
 * Parse GitHub CODEOWNERS file.
 * Supports GitHub, GitLab, and Bitbucket formats.
 */
export function parseCodeOwners(repoPath: string): CodeOwner[] {
  const owners: CodeOwner[] = [];

  // Check multiple possible locations
  const candidates = [
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
  ];

  let content = '';
  let found = false;

  for (const candidate of candidates) {
    const abs = join(repoPath, candidate);
    if (existsSync(abs)) {
      try {
        content = readFileSync(abs, 'utf-8');
        found = true;
        break;
      } catch {
        // try next
      }
    }
  }

  if (!found) return owners;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Parse pattern and owners
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const fileOwners = parts.slice(1).filter(p => p.startsWith('@') || p.includes('@'));

    if (fileOwners.length > 0) {
      owners.push({
        pattern,
        owners: fileOwners,
        line: i + 1,
      });
    }
  }

  return owners;
}

/**
 * Get suggested reviewers for a file path based on CODEOWNERS.
 */
export function getSuggestedReviewers(
  repoPath: string,
  filePath: string
): string[] {
  const owners = parseCodeOwners(repoPath);
  const reviewers: string[] = [];

  for (const owner of owners) {
    const pattern = owner.pattern;

    // Simple glob matching
    if (matchGlob(pattern, filePath)) {
      reviewers.push(...owner.owners);
    }
  }

  // Deduplicate
  return [...new Set(reviewers)];
}

/**
 * Simple glob pattern matching for CODEOWNERS patterns.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize paths
  const p = pattern.replace(/\/$/, '');
  const f = filePath;

  // Exact match
  if (p === f) return true;

  // Directory match (pattern ends with /)
  if (pattern.endsWith('/')) {
    return f.startsWith(p);
  }

  // Wildcard match
  if (p.includes('*')) {
    const regex = new RegExp(
      '^' +
      p.replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*') +
      '$'
    );
    return regex.test(f);
  }

  // Prefix match
  if (f.startsWith(p)) return true;

  // File extension match (e.g., "*.ts")
  if (p.startsWith('*.')) {
    const ext = p.slice(1);
    return f.endsWith(ext);
  }

  return false;
}
