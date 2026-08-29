// Parser entry point — layered pipeline that produces Core nodes/edges.
// Two-pass approach: first extract definitions, then scan bodies for calls.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { GraphNode, GraphEdge, NodeKind, EdgeKind, Evidence } from '../core/types.js';
import { fileId, functionId, classId, interfaceId, tableId, edgeId, apiId } from '../core/ids.js';

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
    };

    // Populate definitions & imports
    extractPass1(meta, relativeFiles, nodes, edges, now);
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
  const { content, lines, relPath, fId, lang } = meta;

  // Extract Imports (JS/TS, Python, Java)
  for (let i = 0; i < lines.length; i++) {
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
  }

  // Extract Definitions based on Language
  if (lang === 'typescript' || lang === 'javascript') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Instantiations: const store = new GraphStore()
      const newInst = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+(\w+)/);
      if (newInst) {
        meta.instantiations.set(newInst[1], newInst[2]);
      }

      // Top-level functions
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
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
    for (let lineIdx = func.startLine; lineIdx <= func.endLine && lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

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

        // Ultimate Fallback: Local ID
        if (!resolvedId) {
          resolvedId = functionId(relPath, calledName);
          confidence = 0.5;
        }

        const edge: GraphEdge = {
          id: edgeId(func.id, resolvedId, 'CALLS'),
          type: 'CALLS', from: func.id, to: resolvedId,
          evidence: [{ file: relPath, line: lineIdx + 1, snippet: line.trim().slice(0, 120) }],
          sources: ['parser'], confidence, conflict: false, updated_at: now,
        };

        if (!edges.some(e => e.id === edge.id)) {
          edges.push(edge);
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
      const id = `api:${method}:${path}`;
      nodes.push({
        id, kind: 'API', name: `${method} ${path}`, path: relPath,
        lang: relPath.endsWith('.yaml') || relPath.endsWith('.yml') ? 'yaml' : 'json',
        startLine: i + 1, updated_at: now,
      });
    }
  }
}

// ─── Generic extraction ────────────────────────────────────────────────────────

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = line.match(
      /(?:^|\s)(?:func|function|fn|def|sub|proc)\s+(\w+)/
    );
    if (fnMatch) {
      const name = fnMatch[1];
      const id = functionId(relPath, name);
      nodes.push({
        id, kind: 'Function', name, path: relPath, lang,
        startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: fnMatch[0].slice(0, 120) }],
        sources: ['parser'], confidence: 0.7, conflict: false, updated_at: now,
      });
    }
  }
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
