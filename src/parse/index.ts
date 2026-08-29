// Parser entry point — layered pipeline that produces Core nodes/edges.
// Two-pass approach: first extract definitions, then scan bodies for calls.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { GraphNode, GraphEdge, NodeKind, EdgeKind, Evidence } from '../core/types.js';
import { fileId, functionId, classId, interfaceId, tableId, edgeId } from '../core/ids.js';

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

  // Also check nested .gitignore files (simplified: only root + one level deep)
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

  // Separate positive and negative patterns
  // Gitignore semantics: process top-to-bottom, last match wins
  // For simplicity: positive patterns add to ignore set, negation removes
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
    // Check if any positive pattern matches
    const isIgnored = positiveTests.some(test => test(norm));
    if (!isIgnored) return false;
    // Check if any negative pattern un-ignores it
    const isUnignored = negativeTests.some(test => test(norm));
    return !isUnignored;
  };
}

function compileGitignorePattern(pattern: string): (path: string) => boolean {
  // Strip leading / — it means "match from root" in gitignore,
  // but we use relative paths so it's equivalent to matching anywhere.
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  const cleanPattern = pattern.replace(/\/$/, ''); // strip trailing /

  // If pattern contains a slash (but not at end), it's a path-specific match
  // e.g. build/output matches only that specific path
  if (cleanPattern.includes('/') && !cleanPattern.endsWith('/')) {
    const regex = gitignoreToRegex(cleanPattern);
    return (p: string) => regex.test(p);
  }

  // Simple pattern (no slash or only trailing slash): match against any path segment
  // e.g. "node_modules" matches "node_modules", "a/node_modules/b"
  const regex = gitignoreToRegex(cleanPattern);
  return (p: string) => {
    // Match against full path
    if (regex.test(p)) return true;
    // Match against any path segment
    const segments = p.split('/');
    for (const seg of segments) {
      if (regex.test(seg)) return true;
    }
    return false;
  };
}

function gitignoreToRegex(pattern: string): RegExp {
  let regexStr = pattern
    // Escape special regex chars except * and ?
    .replace(/([.+^${}()|[\]])/g, '\\$1')
    // ** matches any number of directories
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    // * matches anything except /
    .replace(/\*/g, '[^/]*')
    // ? matches a single char
    .replace(/\?/g, '[^/]')
    // Restore **
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

export function parseRepository(repoPath: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();

  const isIgnored = loadGitignore(repoPath);
  const files = walkDir(repoPath, isIgnored, repoPath);

  for (const filePath of files) {
    const relPath = relative(repoPath, filePath).replace(/\\/g, '/');
    const ext = extname(filePath).toLowerCase();
    const lang = LANGUAGE_MAP[ext];

    if (!lang && ext !== '.dockerfile' && ext !== '') continue;

    const fId = fileId(relPath);
    nodes.push({
      id: fId,
      kind: 'File',
      name: relPath.split('/').pop() || relPath,
      path: relPath,
      lang: lang || 'unknown',
      updated_at: now,
    });

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fileResult = parseFileContent(content, relPath, lang || 'unknown', fId);
    nodes.push(...fileResult.nodes);
    edges.push(...fileResult.edges);
  }

  return { nodes, edges };
}

function parseFileContent(
  content: string,
  relPath: string,
  lang: string,
  fId: string
): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();
  const lines = content.split('\n');

  const importEdges = extractImports(content, relPath, lang, lines, now);
  edges.push(...importEdges);

  switch (lang) {
    case 'typescript':
    case 'javascript':
      extractJS(content, relPath, lang, lines, nodes, edges, now);
      break;
    case 'python':
      extractPython(content, relPath, lines, nodes, edges, now);
      break;
    case 'java':
      extractJava(content, relPath, lines, nodes, edges, now);
      break;
    case 'sql':
    case 'prisma':
      extractSQL(content, relPath, lines, nodes, edges, now);
      break;
    case 'yaml':
    case 'toml':
      extractConfig(content, relPath, lines, nodes, edges, now);
      break;
    default:
      extractGeneric(content, relPath, lang, lines, nodes, edges, now);
      break;
  }

  return { nodes, edges };
}

// ─── Import Extraction ─────────────────────────────────────────────────────────

function extractImports(
  content: string,
  relPath: string,
  lang: string,
  lines: string[],
  now: string
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const fId = fileId(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // JS/TS imports
    if (lang.startsWith('type') || lang.startsWith('java')) {
      const jsImport = line.match(
        /import\s+(?:.*from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/
      );
      if (jsImport) {
        const mod = jsImport[1] || jsImport[2];
        if (mod && !mod.startsWith('.') && !mod.startsWith('/')) {
          const extId = `ext:${mod}`;
          edges.push({
            id: edgeId(fId, extId, 'IMPORTS'),
            type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }
    }

    // Python imports
    if (lang === 'python') {
      const pyImport = line.match(
        /(?:from\s+(\S+)\s+import|import\s+(\S+))/
      );
      if (pyImport) {
        const mod = pyImport[1] || pyImport[2];
        if (mod && !mod.startsWith('.') && !mod.startsWith('/')) {
          const extId = `ext:${mod.split('.')[0]}`;
          edges.push({
            id: edgeId(fId, extId, 'IMPORTS'),
            type: 'IMPORTS', from: fId, to: extId,
            evidence: [{ file: relPath, line: i + 1, snippet: line.slice(0, 120) }],
            sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
          });
        }
      }
    }

    // Java imports
    if (lang === 'java') {
      const javaImport = line.match(/import\s+(?:static\s+)?([a-zA-Z0-9_.]+);/);
      if (javaImport) {
        const mod = javaImport[1];
        if (mod && !mod.startsWith('java.lang') && !mod.startsWith('javax.')) {
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

  return edges;
}

// ─── JavaScript/TypeScript (Two-Pass) ──────────────────────────────────────────
// Pass 1: Extract function/method/class/interface definitions with line ranges
// Pass 2: Scan each function body for calls to other known functions

interface FuncDef {
  name: string;
  id: string;
  kind: 'Function' | 'Method';
  startLine: number;
  endLine: number;
  sig: string;
}

function extractJS(
  content: string,
  relPath: string,
  lang: string,
  lines: string[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  now: string
): void {
  const fId = fileId(relPath);
  const funcDefs: FuncDef[] = [];

  // ─── Pass 1: Find all definitions ──────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Top-level functions
    const fnMatch = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/
    );
    if (fnMatch) {
      const name = fnMatch[1];
      const sig = fnMatch[0];
      const id = functionId(relPath, name);
      const endLine = findClosingBrace(lines, i);
      funcDefs.push({ name, id, kind: 'Function', startLine: i, endLine, sig });

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
    const arrowMatch = line.match(
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/
    );
    if (arrowMatch) {
      const name = arrowMatch[1];
      const id = functionId(relPath, name);
      const endLine = findClosingBrace(lines, i);
      funcDefs.push({ name, id, kind: 'Function', startLine: i, endLine, sig: arrowMatch[0] });

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

    // Static methods: static async methodName(...)
    const staticMethodMatch = line.match(
      /static\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)/
    );
    if (staticMethodMatch) {
      const name = staticMethodMatch[1];
      const id = functionId(relPath, name);
      const endLine = findClosingBrace(lines, i);
      funcDefs.push({ name, id, kind: 'Method', startLine: i, endLine, sig: staticMethodMatch[0] });

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

    // Instance methods: methodName(...)  { (indented)
    const methodMatch = line.match(
      /^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (!JS_KEYWORDS.has(name)) {
        const id = functionId(relPath, name);
        const endLine = findClosingBrace(lines, i);
        funcDefs.push({ name, id, kind: 'Method', startLine: i, endLine, sig: methodMatch[0].trim() });

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
    const classMatch = line.match(
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/
    );
    if (classMatch) {
      const name = classMatch[1];
      const id = classId(relPath, name);
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

    // Interfaces (TypeScript)
    if (lang === 'typescript') {
      const ifaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)/);
      if (ifaceMatch) {
        const name = ifaceMatch[1];
        const id = interfaceId(relPath, name);
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

  // ─── Pass 2: Scan each function body for calls ─────────────────────────
  const allFuncNames = new Set(funcDefs.map(f => f.name));

  for (const func of funcDefs) {
    for (let lineIdx = func.startLine; lineIdx <= func.endLine && lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // Find all function call patterns: word( or Class.method( or obj.method(
      const callPattern = /\b([A-Z]\w*)\.(\w+)\s*\(|\.(\w+)\s*\(|\b([a-z]\w+)\s*\(/g;
      let match;
      while ((match = callPattern.exec(line)) !== null) {
        let calledName: string | null = null;

        if (match[1] && match[2]) {
          // Class.method() — static method call
          calledName = match[2];
        } else if (match[3]) {
          // .method() — instance method call
          calledName = match[3];
        } else if (match[4]) {
          // functionName() — plain call
          calledName = match[4];
        }

        if (calledName && !JS_KEYWORDS.has(calledName) && calledName !== func.name) {
          const calledId = functionId(relPath, calledName);
          const edge: GraphEdge = {
            id: edgeId(func.id, calledId, 'CALLS'),
            type: 'CALLS', from: func.id, to: calledId,
            evidence: [{ file: relPath, line: lineIdx + 1, snippet: match[0].slice(0, 120) }],
            sources: ['parser'], confidence: 0.6, conflict: false, updated_at: now,
          };
          // Avoid duplicate edges
          if (!edges.some(e => e.id === edge.id)) {
            edges.push(edge);
          }
        }
      }
    }
  }
}

// Find the closing brace of a code block starting at a given line
function findClosingBrace(lines: string[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return Math.min(startLine + 50, lines.length - 1); // fallback
}

// ─── Python ────────────────────────────────────────────────────────────────────

function extractPython(
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

    const fnMatch = line.match(/(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const name = fnMatch[1];
      const sig = fnMatch[0];
      const id = functionId(relPath, name);
      const isMethod = line.startsWith('    ') || line.startsWith('\t');
      nodes.push({
        id, kind: isMethod ? 'Method' : 'Function', name, path: relPath,
        lang: 'python', signature: sig, startLine: i + 1, updated_at: now,
      });
      edges.push({
        id: edgeId(fId, id, 'CONTAINS'),
        type: 'CONTAINS', from: fId, to: id,
        evidence: [{ file: relPath, line: i + 1, snippet: sig.slice(0, 120) }],
        sources: ['parser'], confidence: 1.0, conflict: false, updated_at: now,
      });

      // Scan body for calls
      const endLine = findPythonEnd(lines, i);
      const callPattern = /\b([A-Z]\w*)\.(\w+)\s*\(|\.(\w+)\s*\(|\b([a-z]\w+)\s*\(/g;
      for (let li = i + 1; li <= endLine && li < lines.length; li++) {
        let match;
        while ((match = callPattern.exec(lines[li])) !== null) {
          let calledName: string | null = null;
          if (match[1] && match[2]) calledName = match[2];
          else if (match[3]) calledName = match[3];
          else if (match[4]) calledName = match[4];

          const PY_KEYWORDS = new Set(['if', 'for', 'while', 'print', 'return', 'raise', 'assert', 'with', 'as', 'lambda', 'def', 'class', 'import', 'from', 'try', 'except', 'finally', 'elif', 'else', 'pass', 'del', 'global', 'nonlocal', 'yield', 'async', 'await']);
          if (calledName && !PY_KEYWORDS.has(calledName) && calledName !== name) {
            const calledId = functionId(relPath, calledName);
            const edge: GraphEdge = {
              id: edgeId(id, calledId, 'CALLS'),
              type: 'CALLS', from: id, to: calledId,
              evidence: [{ file: relPath, line: li + 1, snippet: match[0].slice(0, 120) }],
              sources: ['parser'], confidence: 0.6, conflict: false, updated_at: now,
            };
            if (!edges.some(e => e.id === edge.id)) {
              edges.push(edge);
            }
          }
        }
      }
    }

    const classMatch = line.match(/class\s+(\w+)/);
    if (classMatch) {
      const name = classMatch[1];
      const id = classId(relPath, name);
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
