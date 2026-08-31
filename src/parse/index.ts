// Parser entry point — layered pipeline that produces Core nodes/edges.
// Two-pass approach: first extract definitions, then scan bodies for calls.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { GraphNode, GraphEdge, NodeKind, EdgeKind, Evidence } from '../core/types.js';
import { fileId, functionId, classId, interfaceId, tableId, edgeId, apiId, docId } from '../core/ids.js';

export interface ParseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  'coverage', '.archmap', 'vendor', 'target', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache',
]);

const IGNORED_FILES = new Set([
  '.gitignore', '.env', '.env.local', '.env.production',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'Cargo.lock', 'Gemfile.lock',
]);

// ─── .gitignore parsing ────────────────────────────────────────────────────────

function loadGitignore(repoPath: string): (relPath: string) => boolean {
  const gitignorePath = join(repoPath, '.gitignore');
  let patterns: string[] = [];
  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    patterns = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    // No .gitignore — nothing to filter
  }

  // Also check nested .gitignore files
  const nestedIgnores: string[] = [];
  try {
    const entries = readdirSync(repoPath);
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const subGitignore = join(repoPath, entry, '.gitignore');
      try {
        const content = readFileSync(subGitignore, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        for (const line of lines) {
          nestedIgnores.push(`${entry}/${line}`);
        }
      } catch { /* no nested .gitignore */ }
    }
  } catch { /* can't read dir */ }

  patterns = [...patterns, ...nestedIgnores];

  const positiveTests: ((path: string) => boolean)[] = [];
  const negativeTests: ((path: string) => boolean)[] = [];

  for (const p of patterns) {
    if (p.startsWith('!')) {
      negativeTests.push(compileGitignorePattern(p.slice(1)));
    } else {
      positiveTests.push(compileGitignorePattern(p));
    }
  }

  return (relPath: string): boolean => {
    const norm = relPath.replace(/\\/g, '/');
    const isIgnored = positiveTests.some(test => test(norm));
    if (!isIgnored) return false;
    const isUnignored = negativeTests.some(test => test(norm));
    return !isUnignored;
  };
}

function compileGitignorePattern(pattern: string): (path: string) => boolean {
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  const cleanPattern = pattern.replace(/\/$/, '');

  if (cleanPattern.includes('/') && !cleanPattern.endsWith('/')) {
    const regex = gitignoreToRegex(cleanPattern);
    return (p: string) => regex.test(p);
  }

  const regex = gitignoreToRegex(cleanPattern);
  return (p: string) => {
    if (regex.test(p)) return true;
    const segments = p.split('/');
    for (const seg of segments) {
      if (regex.test(seg)) return true;
    }
    return false;
  };
}

function gitignoreToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/([.+^${}()|[\]])/g, '\\$1')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`);
}

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
  '.c': 'c',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala',
  '.sql': 'sql',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json',
  '.toml': 'toml',
  '.proto': 'protobuf',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.md': 'markdown',
  '.tf': 'terraform', '.hcl': 'terraform',
  '.dockerfile': 'docker',
  '.sh': 'shell', '.bash': 'shell',
  '.prisma': 'prisma',
};

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
  'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of',
  'class', 'function', 'const', 'let', 'var', 'import', 'export',
  'from', 'require', 'console', 'Promise', 'Error', 'Math', 'Date',
  'JSON', 'Array', 'Object', 'Map', 'Set', 'RegExp', 'Number',
  'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'undefined',
  'null', 'true', 'false', 'this', 'super', 'async', 'await', 'yield',
]);

// ─── Lexer Helper ─────────────────────────────────────────────────────────────

// Accurate brace counter ignoring braces in comments and string literals
function findClosingBrace(lines: string[], startLine: number): number {
  let depth = 0;
  let inSingleComment = false;
  let inBlockComment = false;
  let inSingleQuoteString = false;
  let inDoubleQuoteString = false;
  let inTemplateString = false;
  let escape = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    inSingleComment = false; // Reset single line comment on new line

    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const ch = line[charIdx];
      const nextCh = line[charIdx + 1] || '';

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        escape = true;
        continue;
      }

      // Handle single line comments
      if (!inBlockComment && !inSingleQuoteString && !inDoubleQuoteString && !inTemplateString && ch === '/' && nextCh === '/') {
        inSingleComment = true;
        break; // skip rest of line
      }

      // Handle block comments
      if (!inSingleComment && !inSingleQuoteString && !inDoubleQuoteString && !inTemplateString) {
        if (ch === '/' && nextCh === '*') {
          inBlockComment = true;
          charIdx++;
          continue;
        }
      }
      if (inBlockComment && ch === '*' && nextCh === '/') {
        inBlockComment = false;
        charIdx++;
        continue;
      }

      if (inSingleComment || inBlockComment) continue;

      // Handle strings
      if (ch === "'" && !inDoubleQuoteString && !inTemplateString) {
        inSingleQuoteString = !inSingleQuoteString;
        continue;
      }
      if (ch === '"' && !inSingleQuoteString && !inTemplateString) {
        inDoubleQuoteString = !inDoubleQuoteString;
        continue;
      }
      if (ch === '`' && !inSingleQuoteString && !inDoubleQuoteString) {
        inTemplateString = !inTemplateString;
        continue;
      }

      if (inSingleQuoteString || inDoubleQuoteString || inTemplateString) continue;

      // Count braces
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return Math.min(startLine + 100, lines.length - 1); // fallback
}

/** True for lines inside template literals / block comments so we don't parse HTML-in-TS as code. */
function maskEmbeddedLines(lines: string[]): boolean[] {
  const skip = Array(lines.length).fill(false);
  let inTemplate = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inTemplate || inBlock) skip[i] = true;
    let escape = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const next = line[c + 1] || '';
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; c++; }
        continue;
      }
      if (inSingle) { if (ch === "'") inSingle = false; continue; }
      if (inDouble) { if (ch === '"') inDouble = false; continue; }
      if (inTemplate) {
        if (ch === '`') inTemplate = false;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { inBlock = true; c++; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '`') { inTemplate = true; skip[i] = true; continue; }
    }
    inSingle = false;
    inDouble = false;
  }
  return skip;
}

// ─── Cross-File Import & Symbol Resolver Data Structures ────────────────────────

interface ImportedSymbol {
  sourcePath?: string; // Resolved relative path to workspace file
  externalPkg?: string; // External NPM package (e.g., '@payments/sdk')
  name: string; // Imported symbol name
}

interface WildcardImport {
  sourcePath?: string;
  externalPkg?: string;
  alias?: string;
}

interface FuncDef {
  name: string;
  id: string;
  kind: 'Function' | 'Method';
  startLine: number;
  endLine: number;
  sig: string;
}

interface FileMeta {
  relPath: string;
  lang: string;
  fId: string;
  content: string;
  lines: string[];
  // Map local symbol name to its node ID (or relative method names)
  definitions: Map<string, string>;
  // Map local symbol name to imported definition details
  imports: Map<string, ImportedSymbol>;
  // Wildcard namespace imports
  wildcardImports: WildcardImport[];
  // Variable instantiations: maps varName -> className
  instantiations: Map<string, string>;
  // Discovered local definitions structure for Pass 2 scan
  funcDefs: FuncDef[];
  skip: boolean[];
}

// ─── Import Path Resolver ──────────────────────────────────────────────────────

function resolveImportPath(currentFile: string, importPath: string, allFiles: string[]): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  const currentDir = currentFile.includes('/') ? currentFile.substring(0, currentFile.lastIndexOf('/')) : '';
  const parts = (currentDir + '/' + importPath).split('/');
  const resolvedParts: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolvedParts.pop();
    } else {
      resolvedParts.push(part);
    }
  }

  const targetBase = resolvedParts.join('/');
  const targetBaseNoExt = targetBase.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, '');

  for (const f of allFiles) {
    const fNoExt = f.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, '');
    if (fNoExt === targetBaseNoExt || f === targetBase) {
      return f;
    }
  }

  return null;
}

// ─── Main Pipeline ─────────────────────────────────────────────────────────────

export function parseRepository(repoPath: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();

  const isIgnored = loadGitignore(repoPath);
  const files = walkDir(repoPath, isIgnored, repoPath);
  const relativeFiles = files.map(f => relative(repoPath, f).replace(/\\/g, '/'));

  // Multi-Pass Architecture
  const fileMetas: FileMeta[] = [];

  // ─── Pass 1: Parse definitions, instantiations, and imports for ALL files ───
  for (const filePath of files) {
    const relPath = relative(repoPath, filePath).replace(/\\/g, '/');
    const ext = extname(filePath).toLowerCase();
    const lang = LANGUAGE_MAP[ext];

    if (lang === 'markdown') {
      let md = '';
      try { md = readFileSync(filePath, 'utf-8'); } catch { continue; }
      extractDoc(relPath, md, nodes, edges, now);
      continue;
    }

    if (!lang && ext !== '.dockerfile' && ext !== '') continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const fId = fileId(relPath);

    // Init file node
    nodes.push({
      id: fId,
      kind: 'File',
      name: relPath.split('/').pop() || relPath,
      path: relPath,
      lang: lang || 'unknown',
      updated_at: now,
    });

    const meta: FileMeta = {
      relPath,
      lang: lang || 'unknown',
      fId,
      content,
      lines,
      definitions: new Map(),
      imports: new Map(),
      wildcardImports: [],
      instantiations: new Map(),
      funcDefs: [],
      skip: maskEmbeddedLines(lines),
    };

    // Populate definitions & imports
    extractPass1(meta, relativeFiles, nodes, edges, now);
    extractTests(meta, nodes, edges, now);
    fileMetas.push(meta);
  }

  // Map global symbol definitions across workspace for unique fallback
  const globalDefinitions = new Map<string, string>(); // symbol -> node ID
  for (const meta of fileMetas) {
    for (const [sym, id] of meta.definitions.entries()) {
      // If symbol is unique, allow global resolution
      if (!globalDefinitions.has(sym)) {
        globalDefinitions.set(sym, id);
      } else {
        // Mark as ambiguous
        globalDefinitions.set(sym, 'AMBIGUOUS');
      }
    }
  }

  // ─── Pass 2: Resolve symbol references and trace calls ───────────────────────
  for (const meta of fileMetas) {
    extractPass2(meta, fileMetas, globalDefinitions, nodes, edges, now);
  }

  extractManifests(repoPath, relativeFiles, files, nodes, edges, now);
  return finalizeGraph(nodes, edges, now);
}

/** Parse a single file's content into nodes/edges (definitions only — no call-graph pass). */
export function parseFileContent(relPath: string, content: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();
  const posix = relPath.replace(/\\/g, '/');
  const ext = extname(posix).toLowerCase();
  const lang = LANGUAGE_MAP[ext];

  if (lang === 'markdown') {
    extractDoc(posix, content, nodes, edges, now);
    return { nodes, edges };
  }
  if (!lang && ext !== '.dockerfile' && ext !== '') return { nodes, edges };

  const lines = content.split(/\r?\n/);
  const fId = fileId(posix);
  nodes.push({
    id: fId,
    kind: 'File',
    name: posix.split('/').pop() || posix,
    path: posix,
    lang: lang || 'unknown',
    updated_at: now,
  });
  const meta: FileMeta = {
    relPath: posix,
    lang: lang || 'unknown',
    fId,
    content,
    lines,
    definitions: new Map(),
    imports: new Map(),
    wildcardImports: [],
    instantiations: new Map(),
    funcDefs: [],
    skip: maskEmbeddedLines(lines),
  };
  extractPass1(meta, [posix], nodes, edges, now);
  extractTests(meta, nodes, edges, now);
  return { nodes, edges };
}

// ─── Pass 1 Extraction Logic ───────────────────────────────────────────────────

function extractPass1(
  meta: FileMeta,
  allFiles: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const { content, lines, relPath, fId, lang, skip } = meta;

  // Extract Imports (JS/TS, Python, Java)
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const line = lines[i].trim();

    // JS/TS Imports
    if (lang === 'typescript' || lang === 'javascript') {
      // Case A: import { a, b as c } from 'path'
      const curlyImport = line.match(/import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/);
      if (curlyImport) {
        const path = curlyImport[2];
        const resolved = resolveImportPath(relPath, path, allFiles);
        const symbolsStr = curlyImport[1];
        const symbols = symbolsStr.split(',').map(s => s.trim());

        for (const sym of symbols) {
          if (!sym) continue;
          let local = sym;
          let exported = sym;
          if (sym.includes(' as ')) {
            const parts = sym.split(/\s+as\s+/);
            exported = parts[0].trim();
            local = parts[1].trim();
          }
          if (resolved) {
            meta.imports.set(local, { sourcePath: resolved, name: exported });
            const targetFileId = fileId(resolved);
            const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
            if (!edges.some(e => e.id === fileEdgeId)) {
              edges.push({
                id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
                evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
                sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
              });
            }
          } else {
            meta.imports.set(local, { externalPkg: path, name: exported });
            const extId = `ext:${path}`;
            const eId = edgeId(fId, extId, 'IMPORTS');
            if (!edges.some(e => e.id === eId)) {
              edges.push({
                id: eId, type: 'IMPORTS', from: fId, to: extId,
                evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
                sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
              });
            }
          }
        }
        continue;
      }

      // Case B: import defaultExport from 'path'
      const defaultImport = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (defaultImport) {
        const local = defaultImport[1];
        const path = defaultImport[2];
        const resolved = resolveImportPath(relPath, path, allFiles);

        if (resolved) {
          meta.imports.set(local, { sourcePath: resolved, name: 'default' });
          const targetFileId = fileId(resolved);
          const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
          if (!edges.some(e => e.id === fileEdgeId)) {
            edges.push({
              id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        } else {
          meta.imports.set(local, { externalPkg: path, name: 'default' });
          const extId = `ext:${path}`;
          const eId = edgeId(fId, extId, 'IMPORTS');
          if (!edges.some(e => e.id === eId)) {
            edges.push({
              id: eId, type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        }
        continue;
      }

      // Case C: import * as alias from 'path'
      const starImport = line.match(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (starImport) {
        const alias = starImport[1];
        const path = starImport[2];
        const resolved = resolveImportPath(relPath, path, allFiles);

        if (resolved) {
          meta.wildcardImports.push({ sourcePath: resolved, alias });
          const targetFileId = fileId(resolved);
          const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
          if (!edges.some(e => e.id === fileEdgeId)) {
            edges.push({
              id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        } else {
          meta.wildcardImports.push({ externalPkg: path, alias });
          const extId = `ext:${path}`;
          const eId = edgeId(fId, extId, 'IMPORTS');
          if (!edges.some(e => e.id === eId)) {
            edges.push({
              id: eId, type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        }
        continue;
      }

      // Case D: const alias = require('path')
      const reqImport = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (reqImport) {
        const alias = reqImport[1];
        const path = reqImport[2];
        const resolved = resolveImportPath(relPath, path, allFiles);
        if (resolved) {
          meta.wildcardImports.push({ sourcePath: resolved, alias });
          const targetFileId = fileId(resolved);
          const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
          if (!edges.some(e => e.id === fileEdgeId)) {
            edges.push({
              id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        } else {
          meta.wildcardImports.push({ externalPkg: path, alias });
          const extId = `ext:${path}`;
          const eId = edgeId(fId, extId, 'IMPORTS');
          if (!edges.some(e => e.id === eId)) {
            edges.push({
              id: eId, type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        }
        continue;
      }
    }

    // Python Imports
    if (lang === 'python') {
      const fromImport = line.match(/^from\s+(\S+)\s+import\s+(.+)$/);
      if (fromImport) {
        const mod = fromImport[1];
        const symbolsStr = fromImport[2];
        const path = mod.replace(/\./g, '/') + '.py';
        const resolved = allFiles.find(f => f.endsWith(path)) || null;

        const symbols = symbolsStr.split(',').map(s => s.trim());
        for (const sym of symbols) {
          let local = sym;
          let exported = sym;
          if (sym.includes(' as ')) {
            const parts = sym.split(/\s+as\s+/);
            exported = parts[0].trim();
            local = parts[1].trim();
          }
          if (resolved) {
            meta.imports.set(local, { sourcePath: resolved, name: exported });
            const targetFileId = fileId(resolved);
            const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
            if (!edges.some(e => e.id === fileEdgeId)) {
              edges.push({
                id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
                evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
                sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
              });
            }
          } else {
            meta.imports.set(local, { externalPkg: mod, name: exported });
          }
        }
        continue;
      }

      const pyImport = line.match(/^import\s+(\S+)(?:\s+as\s+(\w+))?$/);
      if (pyImport) {
        const mod = pyImport[1];
        const alias = pyImport[2] || mod.split('.').pop() || mod;
        const path = mod.replace(/\./g, '/') + '.py';
        const resolved = allFiles.find(f => f.endsWith(path)) || null;

        if (resolved) {
          meta.wildcardImports.push({ sourcePath: resolved, alias });
          const targetFileId = fileId(resolved);
          const fileEdgeId = edgeId(fId, targetFileId, 'IMPORTS');
          if (!edges.some(e => e.id === fileEdgeId)) {
            edges.push({
              id: fileEdgeId, type: 'IMPORTS', from: fId, to: targetFileId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
            });
          }
        } else {
          meta.wildcardImports.push({ externalPkg: mod, alias });
        }
        continue;
      }
    }

    // Java Imports
    if (lang === 'java') {
      const javaImport = line.match(/^import\s+(?:static\s+)?([a-zA-Z0-9_.]+);/);
      if (javaImport) {
        const mod = javaImport[1];
        if (!mod.startsWith('java.lang') && !mod.startsWith('javax.')) {
          const pkg = mod.split('.').slice(0, -1).join('.');
          const extId = `ext:${pkg}`;
          edges.push({
            id: edgeId(fId, extId, 'IMPORTS'),
            type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }
    }

    // Go Imports: import "pkg" or import ( "pkg1" "pkg2" )
    if (lang === 'go') {
      const goImport = line.match(/^import\s+"([^"]+)"/);
      if (goImport) {
        const mod = goImport[1];
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now });
        }
        continue;
      }
      const goImportBlock = line.match(/^"([^"]+)"/);
      if (goImportBlock && lines[i - 1]?.trim().startsWith('import')) {
        const mod = goImportBlock[1];
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now });
        }
      }
    }

    // Rust Imports: use crate::module; use std::collections::HashMap;
    if (lang === 'rust') {
      const rustUse = line.match(/^use\s+([a-zA-Z0-9_:]+);/);
      if (rustUse) {
        const mod = rustUse[1];
        const parts = mod.split('::');
        const extId = parts[0] === 'crate' || parts[0] === 'super' || parts[0] === 'self'
          ? `file:${relPath.replace(/[^/]+$/, parts.slice(1).join('/') + '.rs')}`
          : `ext:${parts[0]}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
        continue;
      }
      const rustMod = line.match(/^mod\s+(\w+)/);
      if (rustMod) {
        const modName = rustMod[1];
        const targetPath = relPath.replace(/[^/]+$/, modName + '.rs');
        const targetFileId = fileId(targetPath);
        if (!edges.some(e => e.id === edgeId(fId, targetFileId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, targetFileId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: targetFileId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
      }
    }

            // Ruby Imports: require, require_relative, autoload
    if (lang === 'ruby') {
      const rubyReq = line.match(/^\s*(?:require_relative|require|autoload)\s*['"'"'"](\w+)['"'"'"]/);
      if (rubyReq) {
        const mod = rubyReq[1];
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
      }
    }

    // PHP Imports: use, include, require
    if (lang === 'php') {
      const phpUse = line.match(/^use\s+([A-Za-z0-9_\\]+);/);
      if (phpUse) {
        const mod = phpUse[1].replace(/\\/g, '/').toLowerCase();
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
        continue;
      }
      const phpInc = line.match(/^\s*(?:include|require|include_once|require_once)\s*['"'"'"](\w+)['"'"'"]/);
      if (phpInc) {
        const mod = phpInc[1];
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
      }
    }

    // C# Imports: using, global using
    if (lang === 'csharp') {
      const csUsing = line.match(/^using\s+([A-Za-z0-9_.]+);/);
      if (csUsing) {
        const mod = csUsing[1];
        const extId = `ext:${mod}`;
        if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
          edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
        }
      }
    }

    // Swift Imports: import Module
    if (lang === 'swift') {
      const swiftImport = line.match(/^import\s+(\w+)/);
      if (swiftImport) {
        const mod = swiftImport[1];
        const stdlib = ['Foundation', 'UIKit', 'SwiftUI', 'Combine', 'CoreData', 'CoreGraphics', 'Dispatch', 'XCTest'];
        if (!stdlib.includes(mod)) {
          const extId = `ext:${mod}`;
          if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
            edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
          }
        }
      }
    }

    // Kotlin Imports: import, package
    if (lang === 'kotlin') {
      const ktImport = line.match(/^import\s+([a-zA-Z0-9_.]+)/);
      if (ktImport) {
        const mod = ktImport[1];
        const pkg = mod.split('.').slice(0, -1).join('.');
        if (!pkg.startsWith('kotlin') && !pkg.startsWith('java.lang')) {
          const extId = `ext:${pkg}`;
          if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
            edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
          }
        }
      }
    }

    // Scala Imports: import
    if (lang === 'scala') {
      const scalaImport = line.match(/^import\s+([a-zA-Z0-9_.]+)/);
      if (scalaImport) {
        const mod = scalaImport[1];
        if (!mod.startsWith('scala.') && !mod.startsWith('java.')) {
          const extId = `ext:${mod}`;
          if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
            edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
          }
        }
      }
    }

    // C/C++ Includes: #include <header> or #include "header"
    if (lang === 'c' || lang === 'cpp') {
      const cppInclude = line.match(/^#\s*include\s*[<"]([^>"]+)[>"]/);
      if (cppInclude) {
        const header = cppInclude[1];
        const isStd = /^(stdio|stdlib|string|math|assert|errno|limits|float|ctype|signal|stdarg|stddef|time|setjmp|stdint|inttypes|stdbool|complex|fenv|locale|tgmath|wchar|wctype)/.test(header);
        if (!isStd) {
          const extId = `ext:${header}`;
          if (!edges.some(e => e.id === edgeId(fId, extId, 'IMPORTS'))) {
            edges.push({ id: edgeId(fId, extId, 'IMPORTS'), type: 'IMPORTS', from: fId, to: extId,
              evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
              sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now });
          }
        }
      }
    }
  }

  // Extract Definitions based on Language
  if (lang === 'typescript' || lang === 'javascript') {
    for (let i = 0; i < lines.length; i++) {
      if (skip[i]) continue;
      const line = lines[i];

      // Instantiations: const store = new GraphStore()
      const newInst = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+(\w+)/);
      if (newInst) {
        meta.instantiations.set(newInst[1], newInst[2]);
      }

      // Top-level functions
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (fnMatch) {
        const name = fnMatch[1];
        const sig = fnMatch[0];
        const id = functionId(relPath, name);
        const endLine = findClosingBrace(lines, i);
        meta.funcDefs.push({ name, id, kind: 'Function', startLine: i, endLine, sig });
        meta.definitions.set(name, id);

        nodes.push({
          id, kind: 'Function', name, path: relPath, lang,
          signature: sig, startLine: i + 1, endLine: endLine + 1, updated_at: now,
        });
        edges.push({
          id: edgeId(fId, id, 'CONTAINS'),
          type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: sig.slice(0, 120) }],
          sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
        });
        continue;
      }

      // Arrow functions / const assigned functions
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/);
      if (arrowMatch) {
        const name = arrowMatch[1];
        const id = functionId(relPath, name);
        const endLine = findClosingBrace(lines, i);
        meta.funcDefs.push({ name, id, kind: 'Function', startLine: i, endLine, sig: arrowMatch[0] });
        meta.definitions.set(name, id);

        nodes.push({
          id, kind: 'Function', name, path: relPath, lang,
          signature: arrowMatch[0].slice(0, 200), startLine: i + 1, endLine: endLine + 1, updated_at: now,
        });
        edges.push({
          id: edgeId(fId, id, 'CONTAINS'),
          type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: arrowMatch[0].slice(0, 120) }],
          sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
        });
        continue;
      }

      // Static methods
      const staticMethodMatch = line.match(/static\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)/);
      if (staticMethodMatch) {
        const name = staticMethodMatch[1];
        const id = functionId(relPath, name);
        const endLine = findClosingBrace(lines, i);
        meta.funcDefs.push({ name, id, kind: 'Method', startLine: i, endLine, sig: staticMethodMatch[0] });
        meta.definitions.set(name, id);

        nodes.push({
          id, kind: 'Method', name, path: relPath, lang,
          signature: staticMethodMatch[0].slice(0, 200), startLine: i + 1, endLine: endLine + 1, updated_at: now,
        });
        edges.push({
          id: edgeId(fId, id, 'CONTAINS'),
          type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: staticMethodMatch[0].slice(0, 120) }],
          sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
        });
        continue;
      }

      // Instance methods: methodName(...) {
      const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/);
      if (methodMatch) {
        const name = methodMatch[1];
        if (!JS_KEYWORDS.has(name)) {
          const id = functionId(relPath, name);
          const endLine = findClosingBrace(lines, i);
          meta.funcDefs.push({ name, id, kind: 'Method', startLine: i, endLine, sig: methodMatch[0].trim() });
          meta.definitions.set(name, id);

          nodes.push({
            id, kind: 'Method', name, path: relPath, lang,
            signature: methodMatch[0].trim().slice(0, 200), startLine: i + 1, endLine: endLine + 1, updated_at: now,
          });
          edges.push({
            id: edgeId(fId, id, 'CONTAINS'),
            type: 'CONTAINS', from: fId, to: id,
            evidence: [{ file: relPath, line: i + 1, snippet: methodMatch[0].trim().slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }

      // Classes
      const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1];
        const id = classId(relPath, name);
        meta.definitions.set(name, id);

        nodes.push({
          id, kind: 'Class', name, path: relPath, lang,
          startLine: i + 1, updated_at: now,
        });
        edges.push({
          id: edgeId(fId, id, 'CONTAINS'),
          type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: classMatch[0] }],
          sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
        });
      }

      // Interfaces
      if (lang === 'typescript') {
        const ifaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)/);
        if (ifaceMatch) {
          const name = ifaceMatch[1];
          const id = interfaceId(relPath, name);
          meta.definitions.set(name, id);

          nodes.push({
            id, kind: 'Interface', name, path: relPath, lang,
            startLine: i + 1, updated_at: now,
          });
          edges.push({
            id: edgeId(fId, id, 'CONTAINS'),
            type: 'CONTAINS', from: fId, to: id,
            evidence: [{ file: relPath, line: i + 1, snippet: ifaceMatch[0] }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }
    }
  } else if (lang === 'python') {
    extractPythonPass1(meta, nodes, edges, now);
  } else if (lang === 'java') {
    extractJava(content, relPath, lines, nodes, edges, now);
  } else if (lang === 'sql' || lang === 'prisma') {
    extractSQL(content, relPath, lines, nodes, edges, now);
  } else if (lang === 'yaml' || lang === 'toml') {
    extractConfig(content, relPath, lines, nodes, edges, now);
  } else {
    extractGeneric(content, relPath, lang, lines, nodes, edges, now);
  }
}

function extractPythonPass1(
  meta: FileMeta,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const { lines, relPath, fId } = meta;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fnMatch = line.match(/(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const name = fnMatch[1];
      const sig = fnMatch[0];
      const id = functionId(relPath, name);
      const isMethod = line.startsWith('    ') || line.startsWith('\t');
      const endLine = findPythonEnd(lines, i);
      meta.funcDefs.push({ name, id, kind: isMethod ? 'Method' : 'Function', startLine: i, endLine, sig });
      meta.definitions.set(name, id);

      nodes.push({
        id, kind: isMethod ? 'Method' : 'Function', name, path: relPath,
        lang: 'python', signature: sig, startLine: i + 1, endLine: endLine + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: sig.slice(0, 120) }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }

    const classMatch = line.match(/class\s+(\w+)/);
    if (classMatch) {
      const name = classMatch[1];
      const id = classId(relPath, name);
      meta.definitions.set(name, id);

      nodes.push({
        id, kind: 'Class', name, path: relPath,
        lang: 'python', startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: classMatch[0] }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }
  }
}

// ─── Pass 2 Reference Resolution ────────────────────────────────────────────────

function extractPass2(
  meta: FileMeta,
  fileMetas: FileMeta[],
  globalDefinitions: Map<string, string>,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const { lang, relPath, lines, funcDefs } = meta;

  if (lang !== 'typescript' && lang !== 'javascript' && lang !== 'python') return;

  const PY_KEYWORDS = new Set(['if', 'for', 'while', 'print', 'return', 'raise', 'assert', 'with', 'as', 'lambda', 'def', 'class', 'import', 'from', 'try', 'except', 'finally', 'elif', 'else', 'pass', 'del', 'global', 'nonlocal', 'yield', 'async', 'await']);
  const KEYWORDS = lang === 'python' ? PY_KEYWORDS : JS_KEYWORDS;

  const callPattern = /\b([A-Z]\w*)\.(\w+)\s*\(|\b([a-z]\w*)\.(\w+)\s*\(|\.(\w+)\s*\(|\b([a-zA-Z_]\w*)\s*\(/g;

  for (const func of funcDefs) {
    for (let lineIdx = Math.max(0, func.startLine - 2); lineIdx <= func.endLine && lineIdx < lines.length; lineIdx++) {
      if (meta.skip[lineIdx]) continue;
      const line = lines[lineIdx];

      extractDataAndEvents(func, line, lineIdx, meta, nodes, edges, now);

      if (lang === 'python') {
        extractPythonRoute(line, lineIdx, func, meta, nodes, edges, now);
      }

      // Pattern: EXPOSES edge from express routes app.post('/route', handler)
      if (lang === 'typescript' || lang === 'javascript') {
        const expressRoute = line.match(/(?:app|router|route)\.(get|post|put|delete|patch|options)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/i);
        if (expressRoute) {
          const method = expressRoute[1].toUpperCase();
          const path = expressRoute[2];
          const handlerName = expressRoute[3];
          const aId = apiId(method, path);

          // Find handler definition
          const handlerId = meta.definitions.get(handlerName) || functionId(relPath, handlerName);

          // Register API node if not exists
          if (!nodes.some(n => n.id === aId)) {
            nodes.push({
              id: aId, kind: 'API', name: `${method} ${path}`, path: relPath,
              lang, startLine: lineIdx + 1, updated_at: now,
            });
          }

          edges.push({
            id: edgeId(handlerId, aId, 'EXPOSES'),
            type: 'EXPOSES', from: handlerId, to: aId,
            evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }

      let match;
      while ((match = callPattern.exec(line)) !== null) {
        let calledName: string | null = null;
        let objectPrefix: string | null = null;

        if (match[1] && match[2]) {
          // Class.method() or Object.method()
          objectPrefix = match[1];
          calledName = match[2];
        } else if (match[3] && match[4]) {
          // camelCaseObject.method()
          objectPrefix = match[3];
          calledName = match[4];
        } else if (match[5]) {
          // .method() - instance method, ignore or use global fallback
          calledName = match[5];
        } else if (match[6]) {
          // directCall()
          calledName = match[6];
        }

        if (!calledName || KEYWORDS.has(calledName) || calledName === func.name) continue;

        let resolvedId: string | null = null;
        let confidence = 0.6;

        if (objectPrefix) {
          // 1. Check if objectPrefix is an instantiated variable (e.g. const store = new GraphStore())
          const className = meta.instantiations.get(objectPrefix);
          if (className) {
            // Find class in definitions
            const targetId = meta.definitions.get(className);
            if (targetId) {
              resolvedId = functionId(targetId.split(':')[1], calledName); // Use file of Class
              confidence = 0.9;
            } else {
              // Try globally
              const globalClassId = globalDefinitions.get(className);
              if (globalClassId) {
                resolvedId = functionId(globalClassId.split(':')[1], calledName);
                confidence = 0.8;
              }
            }
          }

          // 2. Check if objectPrefix is an imported namespace (e.g. import * as payments)
          if (!resolvedId) {
            const wildcardImport = meta.wildcardImports.find(w => w.alias === objectPrefix);
            if (wildcardImport && wildcardImport.sourcePath) {
              resolvedId = functionId(wildcardImport.sourcePath, calledName);
              confidence = 0.95;
            } else if (wildcardImport && wildcardImport.externalPkg) {
              resolvedId = `ext:${wildcardImport.externalPkg}`;
              confidence = 0.8;
            }
          }
        } else {
          // Direct function call
          // A. Is defined in this file?
          if (meta.definitions.has(calledName)) {
            resolvedId = meta.definitions.get(calledName)!;
            confidence = 1.0;
          }

          // B. Is imported from another file?
          if (!resolvedId && meta.imports.has(calledName)) {
            const imp = meta.imports.get(calledName)!;
            if (imp.sourcePath) {
              resolvedId = functionId(imp.sourcePath, imp.name);
              confidence = 0.95;
            } else if (imp.externalPkg) {
              resolvedId = `ext:${imp.externalPkg}`;
              confidence = 0.8;
            }
          }

          // C. Try matching wildcard/namespace imports from workspace
          if (!resolvedId) {
            for (const wild of meta.wildcardImports) {
              if (wild.sourcePath) {
                // Check if target file defines calledName
                const targetMeta = fileMetas.find(m => m.relPath === wild.sourcePath);
                if (targetMeta && targetMeta.definitions.has(calledName)) {
                  resolvedId = targetMeta.definitions.get(calledName)!;
                  confidence = 0.9;
                  break;
                }
              }
            }
          }

          // D. Fallback to unique global definition in workspace
          if (!resolvedId && globalDefinitions.has(calledName)) {
            const globId = globalDefinitions.get(calledName)!;
            if (globId !== 'AMBIGUOUS') {
              resolvedId = globId;
              confidence = 0.75;
            }
          }
        }

        // Do not invent a local symbol that was never defined.
        if (!resolvedId) continue;

        const edge: GraphEdge = {
          id: edgeId(func.id, resolvedId, 'CALLS'),
          type: 'CALLS', from: func.id, to: resolvedId,
          evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence, conflict: false, updated_at: now,
        };

        if (!edges.some(e => e.id === edge.id)) {
          edges.push(edge);
        }

        if (isTestFile(relPath) && !resolvedId.startsWith('ext:')) {
          const testNode = nodes.find(n =>
            n.kind === 'Test' && n.path === relPath && (n.startLine ?? 0) <= lineIdx + 1
          );
          const testFrom = testNode?.id ?? `test:${relPath}:file`;
          if (!testNode) {
            ensureNode(nodes, {
              id: testFrom, kind: 'Test', name: relPath.split('/').pop() || relPath,
              path: relPath, lang, updated_at: now,
            });
          }
          pushEdge(edges, {
            id: edgeId(testFrom, resolvedId, 'TESTS'),
            type: 'TESTS', from: testFrom, to: resolvedId,
            evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
            sources: ['parser'], confidence: 0.85, conflict: false, updated_at: now,
          });
        }
      }
    }
  }
}

function findPythonEnd(lines: string[], startLine: number): number {
  const indent = lines[startLine].search(/\S/);
  for (let i = startLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const lineIndent = lines[i].search(/\S/);
    if (lineIndent !== -1 && lineIndent <= indent) return i - 1;
  }
  return lines.length - 1;
}

// ─── Java ──────────────────────────────────────────────────────────────────────

function extractJava(
  content: string,
  relPath: string,
  lines: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const fId = fileId(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fnMatch = line.match(
      /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/
    );
    if (fnMatch) {
      const name = fnMatch[1];
      if (['class', 'interface', 'enum', 'if', 'for', 'while'].includes(name)) continue;
      const id = functionId(relPath, name);
      nodes.push({
        id, kind: 'Method', name, path: relPath,
        lang: 'java', signature: fnMatch[0].slice(0, 200), startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: fnMatch[0].slice(0, 120) }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }

    const classMatch = line.match(/(?:public|private|protected)?\s*(?:abstract\s+)?(?:class|interface)\s+(\w+)/);
    if (classMatch) {
      const name = classMatch[1];
      const id = classId(relPath, name);
      nodes.push({
        id, kind: 'Class', name, path: relPath,
        lang: 'java', startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: classMatch[0] }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }
  }
}

// ─── SQL / Prisma ──────────────────────────────────────────────────────────────

function extractSQL(
  content: string,
  relPath: string,
  lines: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const fId = fileId(relPath);

  for (let i = 0; i < lines.length; i++) {
    const createTable = lines[i].match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?['"]?(\w+)['"]?/i);
    if (createTable) {
      const name = createTable[1];
      const id = tableId(name);
      nodes.push({
        id, kind: 'Table', name, path: relPath,
        lang: 'sql', startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: createTable[0] }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }

    const prismaModel = lines[i].match(/^model\s+(\w+)\s*\{/);
    if (prismaModel) {
      const name = prismaModel[1];
      const id = tableId(name);
      nodes.push({
        id, kind: 'Table', name, path: relPath,
        lang: 'prisma', startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: prismaModel[0] }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });
    }
  }
}

// ─── Config files ──────────────────────────────────────────────────────────────

function extractConfig(
  content: string,
  relPath: string,
  lines: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  for (let i = 0; i < lines.length; i++) {
    const routeMatch = lines[i].match(/^\s*(get|post|put|delete|patch)\s*:\s*['"]([^'"]+)['"]/i);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      const id = apiId(method, path);
      nodes.push({
        id, kind: 'API', name: `${method} ${path}`, path: relPath,
        lang: relPath.endsWith('.yaml') || relPath.endsWith('.yml') ? 'yaml' : 'json',
        startLine: i + 1, updated_at: now,
      });
    }

    // OpenAPI-style path keys: "  /payments:" then a nested "    post:"
    const openapiPath = lines[i].match(/^\s+(\/\S+):\s*$/);
    if (openapiPath) {
      const path = openapiPath[1].replace(/['"]/g, '');
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const methodMatch = lines[j].match(/^\s+(get|post|put|patch|delete|options|head)\s*:/i);
        if (!methodMatch) {
          if (/^\s+\//.test(lines[j])) break;
          continue;
        }
        const method = methodMatch[1].toUpperCase();
        const id = apiId(method, path);
        if (!nodes.some(n => n.id === id)) {
          nodes.push({
            id, kind: 'API', name: `${method} ${path}`, path: relPath,
            lang: 'yaml', startLine: j + 1, updated_at: now,
            tags: ['openapi'],
          });
        }
      }
    }
  }
}

// ─── Generic extraction (all languages) ───────────────────────────────────────

function extractGeneric(
  content: string,
  relPath: string,
  lang: string,
  lines: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const fId = fileId(relPath);
  const isMethod = (line: string): boolean => {
    const indent = line.search(/\S/);
    return indent >= 2; // indented = likely a method
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Go: func Name() / func (r Receiver) Name() / type X struct/interface ──
    if (lang === 'go') {
      const goFunc = line.match(/^func\s+(?:\((?:[^)]*)\)\s+)?(\w+)\s*\(/);
      if (goFunc) {
        const name = goFunc[1];
        const id = functionId(relPath, name);
        nodes.push({ id, kind: 'Function', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const goType = line.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (goType) {
        const name = goType[1];
        const kind = goType[2] === 'interface' ? 'Interface' : 'Class';
        const id = kind === 'Interface' ? interfaceId(relPath, name) : classId(relPath, name);
        nodes.push({ id, kind: kind as any, name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
    }

    // ── Rust: fn Name() / pub fn Name() / struct/enum/trait/impl ──
    if (lang === 'rust') {
      const rustFn = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (rustFn) {
        const name = rustFn[1];
        const id = functionId(relPath, name);
        nodes.push({ id, kind: 'Function', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const rustType = line.match(/^(?:pub\s+)?(?:enum|struct)\s+(\w+)/);
      if (rustType) {
        const name = rustType[1];
        const id = classId(relPath, name);
        nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const rustTrait = line.match(/^(?:pub\s+)?trait\s+(\w+)/);
      if (rustTrait) {
        const name = rustTrait[1];
        const id = interfaceId(relPath, name);
        nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const rustImpl = line.match(/^impl(?:<[^>]+>)?\s+(\w+)/);
      if (rustImpl) {
        const className = rustImpl[1];
        // Parse methods inside impl block
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            if (ch === '}') { depth--; if (depth === 0) break; }
          }
          if (depth === 0 && j > i) break;
          if (depth > 0) {
            const implMethod = lines[j].match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
            if (implMethod) {
              const name = implMethod[1];
              const id = functionId(relPath, name);
              nodes.push({ id, kind: 'Method', name, path: relPath, lang, startLine: j + 1, updated_at: now });
              edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
                evidence: [{ file: relPath, line: j + 1, snippet: lines[j].slice(0, 120) }],
                sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
            }
          }
        }
      }
    }

    // ── Ruby: def Name / class Name / module Name ──
    if (lang === 'ruby') {
      const rubyDef = line.match(/^\s*def\s+(?:self\.)?(\w+[?!]?)/);
      if (rubyDef) {
        const name = rubyDef[1];
        const kind = isMethod(line) ? 'Method' : 'Function';
        const id = functionId(relPath, name);
        nodes.push({ id, kind, name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const rubyClass = line.match(/^(?:class|module)\s+(\w+)/);
      if (rubyClass) {
        const name = rubyClass[1];
        const kind = rubyClass[0].startsWith('module') ? 'Interface' : 'Class';
        const id = kind === 'Interface' ? interfaceId(relPath, name) : classId(relPath, name);
        nodes.push({ id, kind: kind as any, name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
    }

    // ── PHP: function Name() / class Name / interface Name ──
    if (lang === 'php') {
      const phpFunc = line.match(/^(?:public|private|protected|static)?\s*(?:function)\s+(\w+)/);
      if (phpFunc) {
        const name = phpFunc[1];
        const kind = isMethod(line) ? 'Method' : 'Function';
        const id = functionId(relPath, name);
        nodes.push({ id, kind, name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const phpClass = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (phpClass) {
        const name = phpClass[1];
        const id = classId(relPath, name);
        nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
      const phpIface = line.match(/^interface\s+(\w+)/);
      if (phpIface) {
        const name = phpIface[1];
        const id = interfaceId(relPath, name);
        nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now });
        continue;
      }
    }

    // ── C#: method/class/interface/struct ──
    if (lang === 'csharp') {
      const csMethod = line.match(/^(?:public|private|protected|internal|static|async|virtual|override|abstract)?\s*(?:Task<?|void|int|string|bool|object|\w+)\s+(\w+)\s*\(/);
      if (csMethod && !['class', 'interface', 'struct', 'enum', 'if', 'for', 'while', 'switch', 'return', 'new', 'using', 'namespace'].includes(csMethod[1])) {
        const name = csMethod[1];
        const kind = isMethod(line) ? 'Method' : 'Function';
        const id = functionId(relPath, name);
        nodes.push({ id, kind, name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence: 0.7, conflict: false, updated_at: now });
        continue;
      }
      const csClass = line.match(/^(?:public|private|internal)?\s*(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (csClass) { const name = csClass[1]; const id = classId(relPath, name); nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const csIface = line.match(/^(?:public|private|internal)?\s*interface\s+(\w+)/);
      if (csIface) { const name = csIface[1]; const id = interfaceId(relPath, name); nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
    }

    // ── Swift: func Name() / class Name / protocol Name / struct Name ──
    if (lang === 'swift') {
      const swiftFunc = line.match(/^(?:public|private|internal|static)?\s*(?:func|mutating func)\s+(\w+)/);
      if (swiftFunc) { const name = swiftFunc[1]; const id = functionId(relPath, name); nodes.push({ id, kind: 'Function', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const swiftClass = line.match(/^(?:public|private|internal)?\s*(?:final\s+)?class\s+(\w+)/);
      if (swiftClass) { const name = swiftClass[1]; const id = classId(relPath, name); nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const swiftProto = line.match(/^(?:public|private|internal)?\s*protocol\s+(\w+)/);
      if (swiftProto) { const name = swiftProto[1]; const id = interfaceId(relPath, name); nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
    }

    // ── Kotlin: fun Name() / class Name / interface Name ──
    if (lang === 'kotlin') {
      const ktFun = line.match(/^(?:public|private|protected|internal|suspend)?\s*fun\s+(\w+)/);
      if (ktFun) { const name = ktFun[1]; const kind = isMethod(line) ? 'Method' : 'Function'; const id = functionId(relPath, name); nodes.push({ id, kind, name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const ktClass = line.match(/^(?:data\s+)?(?:open\s+)?(?:abstract\s+)?(?:sealed\s+)?class\s+(\w+)/);
      if (ktClass) { const name = ktClass[1]; const id = classId(relPath, name); nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const ktIface = line.match(/^interface\s+(\w+)/);
      if (ktIface) { const name = ktIface[1]; const id = interfaceId(relPath, name); nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
    }

    // ── Scala: def Name() / class Name / trait Name / object Name ──
    if (lang === 'scala') {
      const scalaDef = line.match(/^(?:override\s+)?(?:def|val|var)\s+(\w+)/);
      if (scalaDef && !['class', 'object', 'trait', 'type', 'if', 'for', 'while', 'return', 'val', 'var'].includes(scalaDef[1])) {
        const name = scalaDef[1]; const kind = isMethod(line) ? 'Method' : 'Function'; const id = functionId(relPath, name); nodes.push({ id, kind, name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.7, conflict: false, updated_at: now }); continue; }
      const scalaClass = line.match(/^(?:case\s+)?class\s+(\w+)/);
      if (scalaClass) { const name = scalaClass[1]; const id = classId(relPath, name); nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
      const scalaTrait = line.match(/^trait\s+(\w+)/);
      if (scalaTrait) { const name = scalaTrait[1]; const id = interfaceId(relPath, name); nodes.push({ id, kind: 'Interface', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.8, conflict: false, updated_at: now }); continue; }
    }

    // ── C/C++: function Name() / struct Name / class Name ──
    if (lang === 'c' || lang === 'cpp') {
      const cFunc = line.match(/^(?:static\s+|inline\s+|extern\s+)?(?:\w+(?:\s*\*)+)\s+(\w+)\s*\(/);
      if (cFunc && !['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'struct', 'class', 'enum', 'typedef', 'define', 'include', 'ifdef', 'ifndef', 'pragma'].includes(cFunc[1])) {
        const name = cFunc[1]; const id = functionId(relPath, name); nodes.push({ id, kind: 'Function', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.7, conflict: false, updated_at: now }); continue; }
      if (lang === 'cpp') {
        const cppClass = line.match(/^(?:class|struct)\s+(\w+)/);
        if (cppClass && !['if', 'for', 'while', 'switch'].includes(cppClass[1])) {
          const name = cppClass[1]; const id = classId(relPath, name); nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now }); edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id, evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }], sources: ['parser'], confidence: 0.7, conflict: false, updated_at: now }); continue; }
      }
    }

    // ── Fallback: generic function/class patterns for any language ──
    const fnMatch = line.match(/(?:^|\s)(?:func|function|fn|def|sub|proc|fun)\s+(\w+)/);
    if (fnMatch) {
      const name = fnMatch[1];
      const id = functionId(relPath, name);
      nodes.push({ id, kind: 'Function', name, path: relPath, lang, startLine: i + 1, updated_at: now });
      edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: fnMatch[0].slice(0, 120) }],
        sources: ['parser'], confidence: 0.6, conflict: false, updated_at: now });
    }

    const clsMatch = line.match(/(?:^|\s)(?:class|struct)\s+(\w+)/);
    if (clsMatch) {
      const name = clsMatch[1];
      if (!['if', 'for', 'while', 'switch', 'return', 'new', 'typeof', 'sizeof'].includes(name)) {
        const id = classId(relPath, name);
        nodes.push({ id, kind: 'Class', name, path: relPath, lang, startLine: i + 1, updated_at: now });
        edges.push({ id: edgeId(fId, id, 'CONTAINS'), type: 'CONTAINS', from: fId, to: id,
          evidence: [{ file: relPath, line: i + 1, snippet: clsMatch[0].slice(0, 120) }],
          sources: ['parser'], confidence: 0.6, conflict: false, updated_at: now });
      }
    }
  }
}

// ─── Tests, data ops, manifests, finalize ─────────────────────────────────────

function isTestFile(relPath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(relPath)
    || /(?:^|\/)tests?\//.test(relPath)
    || /(?:^|\/)test_/.test(relPath)
    || /_test\.py$/.test(relPath)
    || /Test\.java$/.test(relPath);
}

function extractTests(
  meta: FileMeta,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  if (!isTestFile(meta.relPath)) return;
  const { lines, relPath, fId, lang } = meta;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const js = line.match(/(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
    const py = line.match(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/);
    const junit = line.match(/void\s+(test\w+)\s*\(/);
    const name = js?.[1] ?? py?.[1] ?? junit?.[1];
    if (!name) continue;
    const id = `test:${relPath}:${name.replace(/\s+/g, '_')}`;
    if (nodes.some(n => n.id === id)) continue;
    nodes.push({
      id, kind: 'Test', name, path: relPath, lang,
      startLine: i + 1, updated_at: now,
    });
    edges.push({
      id: edgeId(fId, id, 'CONTAINS'),
      type: 'CONTAINS', from: fId, to: id,
      evidence: [{ file: relPath, line: i + 1, snippet: line.trim().slice(0, 120) }],
      sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
    });
  }
}

function extractDataAndEvents(
  func: FuncDef,
  line: string,
  lineIdx: number,
  meta: FileMeta,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const { relPath } = meta;
  // Only treat quoted SQL / query APIs as evidence — never CSS `update` or HTML `from`.
  const writes = line.match(/(['"`]).*?\b(?:INSERT\s+INTO\s+['"`]?(\w+)|UPDATE\s+['"`]?(\w+)\s+SET|DELETE\s+FROM\s+['"`]?(\w+))/i);
  if (writes) {
    const tableName = writes[2] || writes[3] || writes[4];
    if (!tableName) {
      // fall through
    } else {
    const tId = tableId(tableName);
    ensureNode(nodes, {
      id: tId, kind: 'Table', name: tableName, path: relPath,
      startLine: lineIdx + 1, updated_at: now,
    });
    pushEdge(edges, {
      id: edgeId(func.id, tId, 'WRITES'),
      type: 'WRITES', from: func.id, to: tId,
      evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
      sources: ['parser'], confidence: 0.9, conflict: false, updated_at: now,
    });
    }
  }

  const reads = line.match(/(['"`]).*?\bSELECT\b.+?\bFROM\s+['"`]?(\w+)/i);
  if (reads && !writes) {
    const tId = tableId(reads[2]);
    ensureNode(nodes, {
      id: tId, kind: 'Table', name: reads[2], path: relPath,
      startLine: lineIdx + 1, updated_at: now,
    });
    pushEdge(edges, {
      id: edgeId(func.id, tId, 'READS'),
      type: 'READS', from: func.id, to: tId,
      evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
      sources: ['parser'], confidence: 0.75, conflict: false, updated_at: now,
    });
  }

  const prisma = line.match(/prisma\.(\w+)\.(create|update|delete|upsert|findMany|findUnique|findFirst)/);
  if (prisma) {
    const tId = tableId(prisma[1]);
    const kind = /create|update|delete|upsert/.test(prisma[2]) ? 'WRITES' : 'READS';
    ensureNode(nodes, {
      id: tId, kind: 'Table', name: prisma[1], path: relPath, updated_at: now,
    });
    pushEdge(edges, {
      id: edgeId(func.id, tId, kind as EdgeKind),
      type: kind as EdgeKind, from: func.id, to: tId,
      evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
      sources: ['parser'], confidence: 0.92, conflict: false, updated_at: now,
    });
  }

  const evt = line.match(/\.(?:emit|publish|subscribe)\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (evt) {
    const eId = `event:${evt[1]}`;
    const type: EdgeKind = /subscribe/.test(line) ? 'SUBSCRIBES' : 'PUBLISHES';
    ensureNode(nodes, {
      id: eId, kind: 'Event', name: evt[1], path: relPath,
      startLine: lineIdx + 1, updated_at: now,
    });
    pushEdge(edges, {
      id: edgeId(func.id, eId, type),
      type, from: func.id, to: eId,
      evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
      sources: ['parser'], confidence: 0.85, conflict: false, updated_at: now,
    });
  }
}

function extractPythonRoute(
  line: string,
  lineIdx: number,
  func: FuncDef,
  meta: FileMeta,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const deco = line.match(/@(?:app|router|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/i);
  if (!deco) return;
  const method = deco[1].toLowerCase() === 'route' ? 'GET' : deco[1].toUpperCase();
  const path = deco[2];
  const aId = apiId(method, path);
  ensureNode(nodes, {
    id: aId, kind: 'API', name: `${method} ${path}`, path: meta.relPath,
    lang: 'python', startLine: lineIdx + 1, updated_at: now,
  });
  pushEdge(edges, {
    id: edgeId(func.id, aId, 'EXPOSES'),
    type: 'EXPOSES', from: func.id, to: aId,
    evidence: [{ file: meta.relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
    sources: ['parser'], confidence: 0.95, conflict: false, updated_at: now,
  });
}

function extractDoc(
  relPath: string,
  content: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const fId = fileId(relPath);
  const dId = docId(relPath);
  const title = (content.match(/^#\s+(.+)$/m)?.[1] ?? relPath.split('/').pop() ?? relPath).trim();
  ensureNode(nodes, {
    id: fId, kind: 'File', name: relPath.split('/').pop() || relPath,
    path: relPath, lang: 'markdown', updated_at: now,
  });
  ensureNode(nodes, {
    id: dId, kind: 'Doc', name: title, path: relPath, lang: 'markdown', updated_at: now,
  });
  pushEdge(edges, {
    id: edgeId(fId, dId, 'DOCUMENTS'),
    type: 'DOCUMENTS', from: fId, to: dId,
    evidence: [{ file: relPath, line: 1, snippet: title.slice(0, 120) }],
    sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
  });
}

function extractManifests(
  repoPath: string,
  relativeFiles: string[],
  absFiles: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  for (let i = 0; i < relativeFiles.length; i++) {
    const rel = relativeFiles[i];
    let json: any;
    try {
      json = JSON.parse(readFileSync(absFiles[i], 'utf-8'));
    } catch {
      continue;
    }

    // ── package.json (Node.js) ──
    if (rel.endsWith('package.json') && !rel.includes('node_modules')) {
      const name = json.name ?? rel.replace(/\/package\.json$/, '');
      const version = json.version ?? 'workspace';
      const pId = `pkg:${name}@${version}`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'json', updated_at: now, metadata: { version } });
      const deps = { ...(json.dependencies ?? {}), ...(json.peerDependencies ?? {}) };
      for (const [dep, ver] of Object.entries(deps)) {
        const extId = `ext:${dep}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: dep, updated_at: now, metadata: { version: String(ver) } });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: `"${dep}": "${String(ver)}"` }],
          sources: ['lockfile'], confidence: 1.0, conflict: false, updated_at: now });
      }
    }

    // ── Cargo.toml (Rust) ──
    if (rel.endsWith('Cargo.toml')) {
      const name = json.package?.name ?? rel.replace(/\/Cargo\.toml$/, '');
      const version = json.package?.version ?? '0.0.0';
      const pId = `pkg:${name}@${version}`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'toml', updated_at: now, metadata: { version } });
      const allDeps = { ...(json.dependencies ?? {}), ...(json.dev_dependencies ?? {}), ...(json.build_dependencies ?? {}) };
      for (const [dep, spec] of Object.entries(allDeps)) {
        const ver = typeof spec === 'string' ? spec : (spec as any).version ?? '*';
        const extId = `ext:${dep}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: dep, updated_at: now, metadata: { version: String(ver) } });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: `${dep} = "${ver}"` }],
          sources: ['lockfile'], confidence: 1.0, conflict: false, updated_at: now });
      }
    }

    // ── go.mod (Go) ──
    if (rel.endsWith('go.mod')) {
      const name = json.module ?? rel.replace(/\/go\.mod$/, '');
      const pId = `pkg:${name}@go`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'toml', updated_at: now });
      if (json.require) {
        for (const req of json.require) {
          const extId = `ext:${req.path}`;
          ensureNode(nodes, { id: extId, kind: 'External', name: req.path, updated_at: now, metadata: { version: req.version } });
          pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
            evidence: [{ file: rel, line: 1, snippet: `require ${req.path} ${req.version}` }],
            sources: ['lockfile'], confidence: 1.0, conflict: false, updated_at: now });
        }
      }
    }

    // ── pom.xml (Maven/Java) ──
    if (rel.endsWith('pom.xml')) {
      const groupId = json.groupId ?? '';
      const artifactId = json.artifactId ?? rel.replace(/\/pom\.xml$/, '');
      const version = json.version ?? '0.0.0';
      const name = `${groupId}:${artifactId}`;
      const pId = `pkg:${name}@${version}`;
      ensureNode(nodes, { id: pId, kind: 'Package', name: artifactId, path: rel, lang: 'xml', updated_at: now, metadata: { version, groupId } });
      if (json.dependencies?.dependency) {
        const deps = Array.isArray(json.dependencies.dependency) ? json.dependencies.dependency : [json.dependencies.dependency];
        for (const dep of deps) {
          const extId = `ext:${dep.groupId}:${dep.artifactId}`;
          ensureNode(nodes, { id: extId, kind: 'External', name: dep.artifactId, updated_at: now, metadata: { version: dep.version } });
          pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
            evidence: [{ file: rel, line: 1, snippet: `${dep.groupId}:${dep.artifactId}:${dep.version}` }],
            sources: ['lockfile'], confidence: 1.0, conflict: false, updated_at: now });
        }
      }
    }

    // ── build.gradle / build.gradle.kts (Gradle) ──
    if (rel.endsWith('build.gradle') || rel.endsWith('build.gradle.kts')) {
      const name = rel.replace(/\/build\.gradle(.kts)?$/, '');
      const pId = `pkg:${name}@gradle`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'groovy', updated_at: now });
      // Parse dependencies block from content
      const content = readFileSync(absFiles[i], 'utf-8');
      const depMatches = content.matchAll(/(?:implementation|api|compile|testImplementation)\s+['"]([^'"]+):([^'"]+):([^'"]+)['"]/g);
      for (const m of depMatches) {
        const [, group, artifact, ver] = m;
        const extId = `ext:${group}:${artifact}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: artifact, updated_at: now, metadata: { version: ver } });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: `${group}:${artifact}:${ver}` }],
          sources: ['lockfile'], confidence: 0.9, conflict: false, updated_at: now });
      }
    }

    // ── Gemfile (Ruby) ──
    if (rel.endsWith('Gemfile')) {
      const name = rel.replace(/\/Gemfile$/, '');
      const pId = `pkg:${name}@ruby`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'ruby', updated_at: now });
      const content = readFileSync(absFiles[i], 'utf-8');
      const gemMatches = content.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:.*?version\s*['"]([^'"]+)['"])?/gm);
      for (const m of gemMatches) {
        const gemName = m[1]; const ver = m[2] ?? '*';
        const extId = `ext:${gemName}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: gemName, updated_at: now, metadata: { version: ver } });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: `gem '${gemName}'` }],
          sources: ['lockfile'], confidence: 0.9, conflict: false, updated_at: now });
      }
    }

    // ── composer.json (PHP) ──
    if (rel.endsWith('composer.json')) {
      const name = json.name ?? rel.replace(/\/composer\.json$/, '');
      const version = json.version ?? '0.0.0';
      const pId = `pkg:${name}@${version}`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'json', updated_at: now, metadata: { version } });
      const deps = { ...(json.require ?? {}), ...(json['require-dev'] ?? {}) };
      for (const [dep, ver] of Object.entries(deps)) {
        if (dep === 'php') continue;
        const extId = `ext:${dep}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: dep, updated_at: now, metadata: { version: String(ver) } });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: `"${dep}": "${ver}"` }],
          sources: ['lockfile'], confidence: 1.0, conflict: false, updated_at: now });
      }
    }

    // ── requirements.txt / setup.py / pyproject.toml (Python) ──
    if (rel.endsWith('requirements.txt')) {
      const name = rel.replace(/\/requirements\.txt$/, '');
      const pId = `pkg:${name}@python`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'text', updated_at: now });
      const content = readFileSync(absFiles[i], 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      for (const line of lines) {
        const m = line.match(/^([a-zA-Z0-9_-]+)(.*)/);
        if (m) {
          const extId = `ext:${m[1].toLowerCase()}`;
          ensureNode(nodes, { id: extId, kind: 'External', name: m[1], updated_at: now });
          pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
            evidence: [{ file: rel, line: 1, snippet: line.trim().slice(0, 120) }],
            sources: ['lockfile'], confidence: 0.9, conflict: false, updated_at: now });
        }
      }
    }

    // ── pyproject.toml (Python) ──
    if (rel.endsWith('pyproject.toml')) {
      const name = json.project?.name ?? rel.replace(/\/pyproject\.toml$/, '');
      const version = json.project?.version ?? '0.0.0';
      const pId = `pkg:${name}@${version}`;
      ensureNode(nodes, { id: pId, kind: 'Package', name, path: rel, lang: 'toml', updated_at: now, metadata: { version } });
      const deps = [...(json.project?.dependencies ?? []), ...(json.project?.['optional-dependencies']?.all ?? [])];
      for (const dep of deps) {
        const depName = dep.split(/[>=<!\[]/)[0].trim().toLowerCase();
        const extId = `ext:${depName}`;
        ensureNode(nodes, { id: extId, kind: 'External', name: depName, updated_at: now });
        pushEdge(edges, { id: edgeId(pId, extId, 'DEPENDS_ON'), type: 'DEPENDS_ON', from: pId, to: extId,
          evidence: [{ file: rel, line: 1, snippet: dep.slice(0, 120) }],
          sources: ['lockfile'], confidence: 0.9, conflict: false, updated_at: now });
      }
    }
  }
}

function finalizeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): ParseResult {
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (end.startsWith('ext:') && !nodeIds.has(end)) {
        nodes.push({
          id: end, kind: 'External', name: end.slice(4), updated_at: now,
        });
        nodeIds.add(end);
      }
    }
  }
  return {
    nodes,
    edges: edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)),
  };
}

function ensureNode(nodes: GraphNode[], node: GraphNode): void {
  if (!nodes.some(n => n.id === node.id)) nodes.push(node);
}

function pushEdge(edges: GraphEdge[], edge: GraphEdge): void {
  if (!edges.some(e => e.id === edge.id)) edges.push(edge);
}

// ─── Filesystem Walker ─────────────────────────────────────────────────────────

function walkDir(dir: string, isIgnored?: (relPath: string) => boolean, repoRoot?: string): string[] {
  const results: string[] = [];
  const root = repoRoot ?? dir;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');

      if (isIgnored && isIgnored(relPath)) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...walkDir(fullPath, isIgnored, root));
        } else if (stat.isFile()) {
          if (!IGNORED_FILES.has(entry)) {
            results.push(fullPath);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Permission denied or other error
  }

  return results;
}
