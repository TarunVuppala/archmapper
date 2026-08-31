// Coverage file ingestion.
// Parses lcov.info, jest coverage output, and similar files
// to create TESTS edges between test nodes and function nodes.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { GraphNode, GraphEdge } from '../core/types.js';
import { functionId, testId, edgeId } from '../core/ids.js';

interface CoverageHit {
  file: string;
  line: number;
  hits: number;
}

/**
 * Parse lcov.info format coverage data.
 * Returns file → line → hits mapping.
 */
function parseLcov(content: string): CoverageHit[] {
  const hits: CoverageHit[] = [];
  let currentFile = '';

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3);
    } else if (line.startsWith('DA:')) {
      const parts = line.slice(3).split(',');
      if (parts.length >= 2) {
        hits.push({
          file: currentFile,
          line: parseInt(parts[0], 10),
          hits: parseInt(parts[1], 10),
        });
      }
    }
  }

  return hits;
}

/**
 * Parse Istanbul/JSON coverage format.
 */
function parseIstanbulJson(content: string): CoverageHit[] {
  const hits: CoverageHit[] = [];

  try {
    const coverage = JSON.parse(content);

    for (const [filePath, fileCoverage] of Object.entries(coverage)) {
      const fc = fileCoverage as any;
      if (fc?.statementMap && fc?.s) {
        for (const [stmtId, hitCount] of Object.entries(fc.s)) {
          const stmtMap = fc.statementMap[stmtId];
          if (stmtMap && (hitCount as number) > 0) {
            hits.push({
              file: filePath,
              line: stmtMap.start?.line || 1,
              hits: hitCount as number,
            });
          }
        }
      }
    }
  } catch {
    // Invalid JSON
  }

  return hits;
}

/**
 * Find all coverage files in a repo.
 */
function findCoverageFiles(repoPath: string): string[] {
  const coverageFiles: string[] = [];
  const candidates = [
    'coverage/lcov.info',
    'coverage/coverage-final.json',
    '.coverage/lcov.info',
    'test/coverage/lcov.info',
    'tmp/coverage/lcov.info',
  ];

  for (const candidate of candidates) {
    const abs = join(repoPath, candidate);
    if (existsSync(abs)) {
      coverageFiles.push(candidate);
    }
  }

  // Also search for lcov files recursively
  try {
    const items = readdirSync(repoPath, { recursive: true });
    for (const item of items) {
      if (typeof item === 'string' && item.endsWith('lcov.info') && !item.includes('node_modules')) {
        if (!coverageFiles.includes(item)) {
          coverageFiles.push(item);
        }
      }
      if (typeof item === 'string' && item.endsWith('coverage-final.json') && !item.includes('node_modules')) {
        if (!coverageFiles.includes(item)) {
          coverageFiles.push(item);
        }
      }
    }
  } catch {
    // ignore
  }

  return coverageFiles;
}

/**
 * Extract function name from a line of code.
 */
function extractFunctionName(line: string): string | null {
  // TypeScript/JavaScript
  const tsMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
  if (tsMatch) return tsMatch[1];

  const arrowMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/);
  if (arrowMatch) return arrowMatch[1];

  const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\(/);
  if (methodMatch) return methodMatch[1];

  // Python
  const pyMatch = line.match(/(?:async\s+)?def\s+(\w+)/);
  if (pyMatch) return pyMatch[1];

  // Java
  const javaMatch = line.match(/(?:public|private|protected|static|final|abstract)\s+(?:\w+\s+)*(\w+)\s*\(/);
  if (javaMatch) return javaMatch[1];

  return null;
}

/**
 * Ingest coverage data and create TESTS edges.
 * Links test files to the functions they cover.
 */
export function ingestCoverage(
  repoPath: string,
  relativeFiles: string[],
  existingNodes: GraphNode[],
  now: string
): { edges: GraphEdge[]; coverageMap: Map<string, number> } {
  const edges: GraphEdge[] = [];
  const coverageMap = new Map<string, number>(); // file → coverage percentage

  const coverageFiles = findCoverageFiles(repoPath);
  if (coverageFiles.length === 0) return { edges, coverageMap };

  // Collect all coverage hits
  const allHits: CoverageHit[] = [];

  for (const covFile of coverageFiles) {
    const abs = join(repoPath, covFile);
    try {
      const content = readFileSync(abs, 'utf-8');
      if (covFile.endsWith('.json')) {
        allHits.push(...parseIstanbulJson(content));
      } else {
        allHits.push(...parseLcov(content));
      }
    } catch {
      // skip unreadable files
    }
  }

  if (allHits.length === 0) return { edges, coverageMap };

  // Group hits by file
  const hitsByFile = new Map<string, CoverageHit[]>();
  for (const hit of allHits) {
    const existing = hitsByFile.get(hit.file) || [];
    existing.push(hit);
    hitsByFile.set(hit.file, existing);
  }

  // Build a map of file → functions from existing nodes
  const functionsByFile = new Map<string, GraphNode[]>();
  for (const node of existingNodes) {
    if ((node.kind === 'Function' || node.kind === 'Method') && node.path) {
      const existing = functionsByFile.get(node.path) || [];
      existing.push(node);
      functionsByFile.set(node.path, existing);
    }
  }

  // Find test files
  const testFiles = existingNodes.filter(n => n.kind === 'Test');

  // For each covered file, find which functions are covered
  for (const [filePath, hits] of hitsByFile) {
    const coveredLines = new Set(hits.filter(h => h.hits > 0).map(h => h.line));
    const totalLines = hits.length;
    const coveredCount = hits.filter(h => h.hits > 0).length;
    coverageMap.set(filePath, totalLines > 0 ? Math.round((coveredCount / totalLines) * 100) : 0);

    const functions = functionsByFile.get(filePath) || [];
    for (const fn of functions) {
      if (fn.startLine && fn.endLine) {
        const fnLines = fn.endLine - fn.startLine + 1;
        const fnCoveredLines = Array.from(coveredLines).filter(
          l => l >= fn.startLine! && l <= fn.endLine!
        ).length;
        const fnCoverage = fnLines > 0 ? fnCoveredLines / fnLines : 0;

        // If function is covered, link it to test files
        if (fnCoverage > 0) {
          // Find which test files might cover this function
          for (const testNode of testFiles) {
            if (testNode.path) {
              // Simple heuristic: if test file name contains function name or vice versa
              const fnName = fn.name.toLowerCase();
              const testName = testNode.name.toLowerCase();
              const testPath = testNode.path.toLowerCase();

              if (
                testName.includes(fnName) ||
                fnName.includes(testName.replace('test', '').replace('spec', '')) ||
                testPath.includes(fnName)
              ) {
                edges.push({
                  id: edgeId(testNode.id, fn.id, 'TESTS'),
                  type: 'TESTS',
                  from: testNode.id,
                  to: fn.id,
                  evidence: [{
                    file: filePath,
                    line: fn.startLine || 1,
                    snippet: `Coverage: ${Math.round(fnCoverage * 100)}% of ${fn.name}`,
                  }],
                  sources: ['coverage'],
                  confidence: Math.min(1.0, fnCoverage + 0.3),
                  conflict: false,
                  updated_at: now,
                });
              }
            }
          }
        }
      }
    }
  }

  return { edges, coverageMap };
}
