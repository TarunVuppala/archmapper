// Tree-sitter universal parser.
// Uses WASM grammars for accurate structural extraction across all languages.
// Falls back to regex parser when tree-sitter is unavailable.

import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { GraphNode, GraphEdge, Evidence } from '../core/types.js';
import { fileId, functionId, classId, interfaceId, methodId, edgeId, apiId } from '../core/ids.js';

// ─── WASM Grammar Mapping ────────────────────────────────────────────────────

const WASM_MAP: Record<string, string> = {
  '.ts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-typescript.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript.wasm',
  '.cjs': 'tree-sitter-javascript.wasm',
  '.py': 'tree-sitter-python.wasm',
  '.java': 'tree-sitter-java.wasm',
  '.go': 'tree-sitter-go.wasm',
  '.rs': 'tree-sitter-rust.wasm',
  '.c': 'tree-sitter-c.wasm',
  '.cpp': 'tree-sitter-cpp.wasm',
  '.cc': 'tree-sitter-cpp.wasm',
  '.cxx': 'tree-sitter-cpp.wasm',
  '.h': 'tree-sitter-c.wasm',
  '.hpp': 'tree-sitter-cpp.wasm',
  '.rb': 'tree-sitter-ruby.wasm',
  '.php': 'tree-sitter-php.wasm',
  '.cs': 'tree-sitter-c_sharp.wasm',
  '.swift': 'tree-sitter-swift.wasm',
  '.kt': 'tree-sitter-kotlin.wasm',
  '.kts': 'tree-sitter-kotlin.wasm',
  '.scala': 'tree-sitter-scala.wasm',
};

// ─── Parser Instance Cache ───────────────────────────────────────────────────

let Parser: any = null;
let initialized = false;
const languageCache = new Map<string, any>();

async function initParser(): Promise<boolean> {
  if (initialized) return Parser !== null;
  try {
    const webTreeSitter = await import('web-tree-sitter');
    Parser = webTreeSitter.Parser;
    if (!Parser) Parser = webTreeSitter.default;
    if (!Parser) throw new Error('No Parser export found');
    await Parser.init();
    initialized = true;
    return true;
  } catch (e: any) {
    // Tree-sitter init failed — will use regex fallback
    initialized = true;
    return false;
  }
}

// Debug: check if tree-sitter is available
let debugLogged = false;
function debugLog(msg: string) {
  if (!debugLogged) {
    process.stderr.write('[tree-sitter] ' + msg + '\n');
    debugLogged = true;
  }
}

async function getLanguage(ext: string): Promise<any | null> {
  const wasmFile = WASM_MAP[ext];
  if (!wasmFile) return null;

  if (languageCache.has(wasmFile)) {
    return languageCache.get(wasmFile);
  }

  // Find the WASM file — try multiple strategies
  const searchPaths: string[] = [];

  // Strategy 1: Derive from process.argv[1] (the CLI entry point)
  try {
    const cliEntry = process.argv[1] || '';
    // cliEntry is like C:\nvm4w\nodejs\node_modules\archmap\dist\cli\index.js
    // Go up to package root: C:\nvm4w\nodejs\node_modules\archmap
    const pkgRoot = join(cliEntry, '..', '..');
    searchPaths.push(join(pkgRoot, 'node_modules', 'tree-sitter-wasms', 'out', wasmFile));
  } catch { /* ignore */ }

  // Strategy 2: Use import.meta.url to find package root
  try {
    const pkgRoot = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '..');
    searchPaths.push(join(pkgRoot, 'node_modules', 'tree-sitter-wasms', 'out', wasmFile));
  } catch { /* ignore */ }

  // Strategy 3: Use require.resolve to find the package
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wasmPkg = require.resolve('tree-sitter-wasms/out/' + wasmFile);
    searchPaths.push(wasmPkg);
  } catch { /* ignore */ }

  // Strategy 4: Search up from cwd
  searchPaths.push(join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', wasmFile));

  let wasmPath = '';
  for (const p of searchPaths) {
    if (existsSync(p)) { wasmPath = p; break; }
  }
  if (!wasmPath) {
    debugLog('WASM not found. Tried: ' + searchPaths.join(', '));
    return null;
  }

  if (!existsSync(wasmPath)) return null;

  try {
    const lang = await Parser.Language.load(wasmPath);
    languageCache.set(wasmFile, lang);
    return lang;
  } catch (e: any) {
    // Language load failed
    return null;
  }
}

// ─── AST Extraction ──────────────────────────────────────────────────────────

interface ExtractedDef {
  name: string;
  kind: 'Function' | 'Method' | 'Class' | 'Interface' | 'Variable';
  startLine: number;
  endLine: number;
  signature: string;
}

interface ExtractedImport {
  source: string;
  symbols: string[];
  isWildcard: boolean;
  alias?: string;
}

interface ExtractedCall {
  caller: string;
  callee: string;
  line: number;
  snippet: string;
}

interface ExtractedRoute {
  method: string;
  path: string;
  handler: string;
  line: number;
  snippet: string;
}

interface TreeSitterResult {
  defs: ExtractedDef[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  routes: ExtractedRoute[];
}

function walkNode(node: any, results: TreeSitterResult, lines: string[], lang: string): void {
  const type = node.type;

  // ─── TypeScript/JavaScript ───────────────────────────────────────────────
  if (lang === 'typescript' || lang === 'javascript') {
    // Function declarations
    if (type === 'function_declaration' || type === 'generator_function_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: 'Function', startLine, endLine, signature: sig });
    }

    // Arrow functions / const assigned
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      const decl = node.firstNamedChild;
      if (decl?.type === 'variable_declarator') {
        const name = decl.childForFieldName('name')?.text || '';
        const value = decl.childForFieldName('value');
        if (value?.type === 'arrow_function' || value?.type === 'function') {
          const startLine = node.startPosition.row + 1;
          const endLine = node.endPosition.row + 1;
          const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
          results.defs.push({ name, kind: 'Function', startLine, endLine, signature: sig });
        }
      }
    }

    // Class declarations
    if (type === 'class_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Class', startLine, endLine, signature: `class ${name}` });
    }

    // Method definitions (inside classes)
    if (type === 'method_definition') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: 'Method', startLine, endLine, signature: sig });
    }

    // Interface declarations (TypeScript)
    if (type === 'interface_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Interface', startLine, endLine, signature: `interface ${name}` });
    }

    // Import statements
    if (type === 'import_statement') {
      const source = node.childForFieldName('source')?.text?.replace(/['"]/g, '') || '';
      const symbols: string[] = [];
      let isWildcard = false;
      let alias: string | undefined;

      const clause = node.firstNamedChild;
      if (clause?.type === 'import_clause') {
        for (const child of clause.namedChildren) {
          if (child.type === 'identifier') {
            // default import
            symbols.push(child.text);
          }
          if (child.type === 'import_specifier') {
            const imported = child.childForFieldName('name')?.text || child.text;
            const local = child.childForFieldName('alias')?.text || imported;
            symbols.push(imported);
            if (imported !== local) alias = local;
          }
          if (child.type === 'namespace_import') {
            isWildcard = true;
            alias = child.firstNamedChild?.text;
          }
        }
      }
      if (source) {
        results.imports.push({ source, symbols, isWildcard, alias });
      }
    }

    // Call expressions
    if (type === 'call_expression') {
      const fn = node.childForFieldName('function');
      let callee = fn?.text || '';
      // Simplify: get just the function name
      if (fn?.type === 'member_access_expression' || fn?.type === 'member_expression') {
        callee = fn.lastNamedChild?.text || callee;
      }
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      if (callee && !['require', 'import', 'console', 'JSON', 'Math', 'Object', 'Array', 'Map', 'Set', 'Promise', 'Error', 'Date', 'RegExp', 'Number', 'String', 'Boolean'].includes(callee)) {
        results.calls.push({ caller: '', callee, line, snippet });
      }
    }

    // Express/Fastify routes
    if (type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'member_access_expression' || fn?.type === 'member_expression') {
        const method = fn.lastNamedChild?.text?.toLowerCase() || '';
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'all'].includes(method)) {
          const args = node.childForFieldName('arguments');
          const firstArg = args?.firstNamedChild;
          if (firstArg?.type === 'string' || firstArg?.type === 'template_string') {
            const path = firstArg.text.replace(/['"`]/g, '');
            const line = node.startPosition.row + 1;
            const snippet = (lines[line - 1] || '').trim().slice(0, 120);
            // Try to find the handler (second argument)
            const handler = args?.namedChildren[1]?.text || '';
            results.routes.push({ method: method.toUpperCase(), path, handler, line, snippet });
          }
        }
      }
    }
  }

  // ─── Python ──────────────────────────────────────────────────────────────
  if (lang === 'python') {
    if (type === 'function_definition') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const isMethod = node.parent?.type === 'block' && node.parent.parent?.type === 'class_definition';
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: isMethod ? 'Method' : 'Function', startLine, endLine, signature: sig });
    }

    if (type === 'class_definition') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Class', startLine, endLine, signature: `class ${name}` });
    }

    if (type === 'import_from_statement') {
      const module = node.childForFieldName('module_name')?.text || '';
      const symbols: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          symbols.push(child.text);
        }
      }
      if (module) results.imports.push({ source: module, symbols, isWildcard: false });
    }

    if (type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name') {
          results.imports.push({ source: child.text, symbols: [], isWildcard: true });
        }
      }
    }

    if (type === 'call') {
      const fn = node.childForFieldName('function');
      let callee = fn?.text || '';
      if (fn?.type === 'attribute') {
        callee = fn.lastNamedChild?.text || callee;
      }
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      if (callee && !['print', 'len', 'range', 'type', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'isinstance', 'hasattr', 'getattr', 'setattr', 'super', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'abs', 'min', 'max', 'sum', 'any', 'all', 'input', 'open'].includes(callee)) {
        results.calls.push({ caller: '', callee, line, snippet });
      }
    }

    // Flask/FastAPI routes
    if (type === 'decorated_definition') {
      const decorator = node.firstNamedChild;
      if (decorator?.type === 'decorator') {
        const decText = decorator.text;
        const routeMatch = decText.match(/@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/);
        if (routeMatch) {
          const method = routeMatch[1].toUpperCase();
          const path = routeMatch[2];
          const line = node.startPosition.row + 1;
          const snippet = (lines[line - 1] || '').trim().slice(0, 120);
          results.routes.push({ method, path, handler: '', line, snippet });
        }
      }
    }
  }

  // ─── Java ────────────────────────────────────────────────────────────────
  if (lang === 'java') {
    if (type === 'class_declaration' || type === 'enum_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Class', startLine, endLine, signature: `class ${name}` });
    }

    if (type === 'interface_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Interface', startLine, endLine, signature: `interface ${name}` });
    }

    if (type === 'method_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: 'Method', startLine, endLine, signature: sig });
    }

    if (type === 'import_declaration') {
      const path = node.text.replace(/^import\s+(?:static\s+)?/, '').replace(/;$/, '');
      results.imports.push({ source: path, symbols: [], isWildcard: path.endsWith('*') });
    }

    if (type === 'method_invocation') {
      const name = node.childForFieldName('name')?.text || '';
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      results.calls.push({ caller: '', callee: name, line, snippet });
    }

    // Spring routes
    if (type === 'marker_annotation') {
      const text = node.text;
      const routeMatch = text.match(/@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
      if (routeMatch) {
        const method = routeMatch[1].toUpperCase();
        const path = routeMatch[2];
        const line = node.startPosition.row + 1;
        const snippet = (lines[line - 1] || '').trim().slice(0, 120);
        results.routes.push({ method, path, handler: '', line, snippet });
      }
    }
  }

  // ─── Go ──────────────────────────────────────────────────────────────────
  if (lang === 'go') {
    if (type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: 'Function', startLine, endLine, signature: sig });
    }

    if (type === 'type_declaration') {
      for (const child of node.namedChildren) {
        if (child.type === 'type_spec') {
          const name = child.childForFieldName('name')?.text || '';
          const typeNode = child.childForFieldName('type');
          const kind = typeNode?.type === 'interface_type' ? 'Interface' : 'Class';
          const startLine = child.startPosition.row + 1;
          const endLine = child.endPosition.row + 1;
          results.defs.push({ name, kind, startLine, endLine, signature: `${kind.toLowerCase()} ${name}` });
        }
      }
    }

    if (type === 'import_declaration') {
      for (const child of node.namedChildren) {
        if (child.type === 'import_spec') {
          const path = child.childForFieldName('path')?.text?.replace(/"/g, '') || '';
          if (path) results.imports.push({ source: path, symbols: [], isWildcard: false });
        }
      }
    }

    if (type === 'call_expression') {
      const fn = node.childForFieldName('function');
      let callee = fn?.text || '';
      if (fn?.type === 'selector_expression') {
        callee = fn.lastNamedChild?.text || callee;
      }
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      if (callee) results.calls.push({ caller: '', callee, line, snippet });
    }

    // Gin/Echo/Chi routes
    if (type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'selector_expression') {
        const obj = fn.firstNamedChild?.text || '';
        const method = fn.lastNamedChild?.text?.toLowerCase() || '';
        if (['get', 'post', 'put', 'delete', 'patch', 'group'].includes(method)) {
          const args = node.childForFieldName('arguments');
          const firstArg = args?.firstNamedChild;
          if (firstArg?.type === 'interpreted_string_literal' || firstArg?.type === 'raw_string_literal') {
            const path = firstArg.text.replace(/"/g, '');
            const line = node.startPosition.row + 1;
            const snippet = (lines[line - 1] || '').trim().slice(0, 120);
            results.routes.push({ method: method.toUpperCase(), path, handler: obj, line, snippet });
          }
        }
      }
    }
  }

  // ─── Rust ────────────────────────────────────────────────────────────────
  if (lang === 'rust') {
    if (type === 'function_item') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
      results.defs.push({ name, kind: 'Function', startLine, endLine, signature: sig });
    }

    if (type === 'impl_item') {
      // Extract method definitions inside impl blocks
      for (const child of node.namedChildren) {
        if (child.type === 'function_item') {
          const name = child.childForFieldName('name')?.text || '';
          const startLine = child.startPosition.row + 1;
          const endLine = child.endPosition.row + 1;
          const sig = lines.slice(startLine - 1, Math.min(startLine + 1, endLine)).join(' ').slice(0, 200);
          results.defs.push({ name, kind: 'Method', startLine, endLine, signature: sig });
        }
      }
    }

    if (type === 'struct_item') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Class', startLine, endLine, signature: `struct ${name}` });
    }

    if (type === 'trait_item') {
      const name = node.childForFieldName('name')?.text || '';
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      results.defs.push({ name, kind: 'Interface', startLine, endLine, signature: `trait ${name}` });
    }

    if (type === 'use_declaration') {
      const path = node.text.replace(/^use\s+/, '').replace(/;$/, '');
      results.imports.push({ source: path, symbols: [], isWildcard: path.includes('*') });
    }

    if (type === 'call_expression') {
      const fn = node.childForFieldName('function');
      let callee = fn?.text || '';
      if (fn?.type === 'field_expression') {
        callee = fn.lastNamedChild?.text || callee;
      }
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] || '').trim().slice(0, 120);
      if (callee) results.calls.push({ caller: '', callee, line, snippet });
    }
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i), results, lines, lang);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TreeSitterParseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  parser: 'tree-sitter' | 'regex';
}

/**
 * Parse a single file using tree-sitter WASM grammars.
 * Returns nodes and edges extracted from the AST.
 */
export async function parseWithTreeSitter(
  repoPath: string,
  relPath: string,
  content: string,
  now: string
): Promise<TreeSitterParseResult | null> {
  const ext = extname(relPath).toLowerCase();
  const wasmFile = WASM_MAP[ext];
  if (!wasmFile) return null;

  const parserReady = await initParser();
  if (!parserReady) {
    debugLog('Parser init failed for ' + relPath);
    return null;
  }

  const language = await getLanguage(ext);
  if (!language) {
    debugLog('Language not found for ' + ext + ' (' + relPath + ')');
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(content);
    const lines = content.split('\n');
    const results: TreeSitterResult = { defs: [], imports: [], calls: [], routes: [] };

    walkNode(tree.rootNode, results, lines, getLangFromExt(ext));

    // Convert to graph nodes and edges
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fId = fileId(relPath);

    // File node
    nodes.push({
      id: fId,
      kind: 'File',
      name: relPath.split('/').pop() || relPath,
      path: relPath,
      lang: getLangFromExt(ext),
      updated_at: now,
    });

    // Definitions → nodes
    const defNameMap = new Map<string, string>(); // name → node ID
    for (const def of results.defs) {
      let nodeId: string;
      let kind: GraphNode['kind'];

      switch (def.kind) {
        case 'Function':
          nodeId = functionId(relPath, def.name);
          kind = 'Function';
          break;
        case 'Method':
          nodeId = methodId(relPath, def.name);
          kind = 'Method';
          break;
        case 'Class':
          nodeId = classId(relPath, def.name);
          kind = 'Class';
          break;
        case 'Interface':
          nodeId = interfaceId(relPath, def.name);
          kind = 'Interface';
          break;
        default:
          nodeId = functionId(relPath, def.name);
          kind = 'Function';
      }

      defNameMap.set(def.name, nodeId);

      nodes.push({
        id: nodeId,
        kind,
        name: def.name,
        path: relPath,
        lang: getLangFromExt(ext),
        signature: def.signature,
        startLine: def.startLine,
        endLine: def.endLine,
        updated_at: now,
      });

      // CONTAINS edge from file
      edges.push({
        id: edgeId(fId, nodeId, 'CONTAINS'),
        type: 'CONTAINS',
        from: fId,
        to: nodeId,
        evidence: [{ file: relPath, line: def.startLine, snippet: def.signature.slice(0, 120) }],
        sources: ['parser'],
        confidence: 1.0,
        conflict: false,
        updated_at: now,
      });
    }

    // Imports → IMPORTS edges
    for (const imp of results.imports) {
      const resolved = resolveImportPath(relPath, imp.source, repoPath);
      if (resolved) {
        const targetFileId = fileId(resolved);
        edges.push({
          id: edgeId(fId, targetFileId, 'IMPORTS'),
          type: 'IMPORTS',
          from: fId,
          to: targetFileId,
          evidence: [{ file: relPath, line: 1, snippet: `import from ${imp.source}` }],
          sources: ['parser'],
          confidence: 1.0,
          conflict: false,
          updated_at: now,
        });
      } else {
        // External package
        const extId = `ext:${imp.source}`;
        edges.push({
          id: edgeId(fId, extId, 'IMPORTS'),
          type: 'IMPORTS',
          from: fId,
          to: extId,
          evidence: [{ file: relPath, line: 1, snippet: `import from ${imp.source}` }],
          sources: ['parser'],
          confidence: 1.0,
          conflict: false,
          updated_at: now,
        });
      }
    }

    // Calls → CALLS edges (best effort — match callee to known defs)
    for (const call of results.calls) {
      const targetId = defNameMap.get(call.callee);
      if (targetId) {
        // Find the caller (which function contains this call)
        const callerDef = results.defs.find(d =>
          d.kind === 'Function' || d.kind === 'Method'
        );
        if (callerDef) {
          const callerId = defNameMap.get(callerDef.name) || fId;
          edges.push({
            id: edgeId(callerId, targetId, 'CALLS'),
            type: 'CALLS',
            from: callerId,
            to: targetId,
            evidence: [{ file: relPath, line: call.line, snippet: call.snippet }],
            sources: ['parser'],
            confidence: 0.85,
            conflict: false,
            updated_at: now,
          });
        }
      }
    }

    // Routes → API nodes + EXPOSES edges
    for (const route of results.routes) {
      const apiNodeId = apiId(route.method, route.path);
      nodes.push({
        id: apiNodeId,
        kind: 'API',
        name: `${route.method} ${route.path}`,
        path: relPath,
        lang: getLangFromExt(ext),
        startLine: route.line,
        updated_at: now,
      });

      // Link route to handler if found
      const handlerId = defNameMap.get(route.handler);
      if (handlerId) {
        edges.push({
          id: edgeId(handlerId, apiNodeId, 'EXPOSES'),
          type: 'EXPOSES',
          from: handlerId,
          to: apiNodeId,
          evidence: [{ file: relPath, line: route.line, snippet: route.snippet }],
          sources: ['parser'],
          confidence: 0.95,
          conflict: false,
          updated_at: now,
        });
      }
    }

    return { nodes, edges, parser: 'tree-sitter' };
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLangFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.c': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.h': 'c', '.hpp': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.scala': 'scala',
  };
  return map[ext] || 'unknown';
}

function resolveImportPath(currentFile: string, importPath: string, repoPath: string): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;

  const { readdirSync, statSync } = require('node:fs');
  const { join, relative, dirname } = require('node:path');

  const currentDir = dirname(currentFile);
  const parts = (currentDir + '/' + importPath).split('/');
  const resolvedParts: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') resolvedParts.pop();
    else resolvedParts.push(part);
  }

  const targetBase = resolvedParts.join('/');
  const targetBaseNoExt = targetBase.replace(/\.(js|ts|tsx|jsx|mjs|cjs|py|java|go|rs)$/, '');

  // Try to find the file
  try {
    const items = readdirSync(repoPath, { recursive: true, withFileTypes: true });
    for (const item of items) {
      if (!item.isFile()) continue;
      const relPath = join(item.parentPath || item.path, item.name).replace(repoPath, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
      const relNoExt = relPath.replace(/\.(js|ts|tsx|jsx|mjs|cjs|py|java|go|rs)$/, '');
      if (relNoExt === targetBaseNoExt || relPath === targetBase) {
        return relPath;
      }
    }
  } catch { /* ignore */ }

  return null;
}
