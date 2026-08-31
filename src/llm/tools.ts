// Specialized coding & architecture tools — the agent's brain.
// 40+ tools for code analysis, architecture, security, performance, git, and more.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { webSearch, fetchUrl, runCommand as runCommandTool, installPackage } from './web-tools.js';

export interface ToolResult {
  ok: boolean;
  tool: string;
  output: string;
  error?: string;
  duration: number;
}

function run(cmd: string, repoPath: string, timeout = 15000): ToolResult {
  const t0 = Date.now();
  try {
    const output = execSync(cmd, {
      cwd: repoPath, encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    return { ok: true, tool: cmd.split(' ')[0], output: output.trim(), duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: cmd.split(' ')[0], output: '', error: e.message?.slice(0, 500), duration: Date.now() - t0 };
  }
}

function rg(pattern: string, repoPath: string, extra = ''): string {
  try {
    return execSync('rg -n --max-count=8 --max-depth=6 "' + pattern + '" ' + extra + ' --glob "!node_modules" --glob "!.git" --glob "!dist" --glob "!.next" .', {
      cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════
// FILE TOOLS
// ═══════════════════════════════════════════════════════════════════

export function readFile(repoPath: string, filePath: string, startLine?: number, endLine?: number): ToolResult {
  if (!filePath) return { ok: false, tool: 'readFile', output: '', error: 'Usage: readFile <path> [startLine] [endLine]', duration: 0 };
  const abs = join(repoPath, filePath);
  if (!existsSync(abs)) return { ok: false, tool: 'readFile', output: '', error: 'File not found: ' + filePath, duration: 0 };
  const t0 = Date.now();
  try {
    const content = readFileSync(abs, 'utf-8');
    const lines = content.split('\n');
    const start = (startLine || 1) - 1;
    const end = endLine || Math.min(lines.length, start + 100);
    const sliced = lines.slice(start, end);
    const numbered = sliced.map((l, i) => String(start + i + 1).padStart(4) + ' | ' + l).join('\n');
    return { ok: true, tool: 'readFile', output: filePath + ' (' + (start+1) + '-' + end + ' of ' + lines.length + ')\n' + numbered, duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: 'readFile', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

export function searchFiles(repoPath: string, pattern: string): ToolResult {
  if (!pattern) return { ok: false, tool: 'searchFiles', output: '', error: 'Usage: searchFiles <pattern>', duration: 0 };
  const t0 = Date.now();
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const files = items.filter(i => typeof i === 'string' && i.includes(pattern) && !i.includes('node_modules') && !i.includes('.git') && !i.includes('dist') && !i.includes('.next')).slice(0, 25);
    if (files.length === 0) return { ok: true, tool: 'searchFiles', output: 'No files matching "' + pattern + '"', duration: Date.now() - t0 };
    return { ok: true, tool: 'searchFiles', output: 'Found ' + files.length + ' files:\n' + files.map(f => '  ' + f).join('\n'), duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: 'searchFiles', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

export function grepCode(repoPath: string, pattern: string, fileTypes?: string): ToolResult {
  if (!pattern) return { ok: false, tool: 'grepCode', output: '', error: 'Usage: grepCode <pattern> [fileTypes]', duration: 0 };
  const t0 = Date.now();
  const typeFlag = fileTypes ? '-t ' + fileTypes : '';
  const output = rg(pattern, repoPath, typeFlag);
  if (!output) return { ok: true, tool: 'grepCode', output: 'No matches for "' + pattern + '"', duration: Date.now() - t0 };
  const lines = output.split('\n').slice(0, 30);
  return { ok: true, tool: 'grepCode', output: 'Grep "' + pattern + '":\n' + lines.join('\n'), duration: Date.now() - t0 };
}

export function countLines(repoPath: string, filePath: string): ToolResult {
  if (!filePath) return { ok: false, tool: 'countLines', output: '', error: 'Usage: countLines <path>', duration: 0 };
  const t0 = Date.now();
  try {
    const content = readFileSync(join(repoPath, filePath), 'utf-8');
    const lines = content.split('\n');
    const blank = lines.filter(l => l.trim() === '').length;
    const comment = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('*') || l.trim().startsWith('#')).length;
    const code = lines.length - blank - comment;
    return { ok: true, tool: 'countLines', output: filePath + ': ' + lines.length + ' total, ' + code + ' code, ' + comment + ' comments, ' + blank + ' blank', duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: 'countLines', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

export function dirTree(repoPath: string, maxDepth = 3): ToolResult {
  const t0 = Date.now();
  const skip = ['node_modules', '.git', 'dist', '.next', '.archmap', '.playwright-browsers'];
  function walk(dir: string, depth: number): string[] {
    if (depth >= maxDepth) return [];
    const items: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        if (skip.includes(entry)) continue;
        const abs = join(dir, entry);
        const rel = relative(repoPath, abs);
        if (statSync(abs).isDirectory()) { items.push(rel + '/'); items.push(...walk(abs, depth + 1)); }
        else if (extname(entry)) items.push(rel);
      }
    } catch { /* ignore */ }
    return items;
  }
  const tree = walk(repoPath, 0).slice(0, 120);
  return { ok: true, tool: 'dirTree', output: 'Directory tree:\n' + tree.map(f => '  ' + f).join('\n'), duration: Date.now() - t0 };
}

// ═══════════════════════════════════════════════════════════════════
// GIT TOOLS
// ═══════════════════════════════════════════════════════════════════

export function gitLog(repoPath: string, filePath?: string, count = 10): ToolResult {
  const fileArg = filePath ? ' -- "' + filePath + '"' : '';
  return run('git log --oneline --format="%h %s (%an, %ar)" -' + count + fileArg, repoPath);
}

export function gitBlame(repoPath: string, filePath: string, startLine?: number, endLine?: number): ToolResult {
  if (!filePath) return { ok: false, tool: 'gitBlame', output: '', error: 'Usage: gitBlame <file> [startLine] [endLine]', duration: 0 };
  const lineArg = startLine && endLine ? ' -L ' + startLine + ',' + endLine : '';
  return run('git blame --line-porcelain' + lineArg + ' "' + filePath + '" | grep -E "^(author |filename |[0-9a-f]{40})" | head -60', repoPath);
}

export function gitDiff(repoPath: string, ref?: string): ToolResult {
  return run('git diff --stat' + (ref ? ' ' + ref : ''), repoPath);
}

export function gitStatus(repoPath: string): ToolResult {
  return run('git status --short', repoPath);
}

export function gitBranches(repoPath: string): ToolResult {
  return run('git branch -a --sort=-committerdate | head -20', repoPath);
}

export function gitDiffFull(repoPath: string, ref?: string): ToolResult {
  return run('git diff' + (ref ? ' ' + ref : '') + ' --no-color | head -200', repoPath, 10000);
}

// ═══════════════════════════════════════════════════════════════════
// DEV TOOLS
// ═══════════════════════════════════════════════════════════════════

export function runTests(repoPath: string, pattern?: string): ToolResult {
  const cmd = pattern ? 'npx vitest run ' + pattern + ' --reporter=verbose 2>&1 | tail -50' : 'npm test 2>&1 | tail -50';
  return run(cmd, repoPath, 30000);
}

export function findTests(repoPath: string, symbol?: string): ToolResult {
  const t0 = Date.now();
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const testFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.test.ts') || i.endsWith('.test.tsx') || i.endsWith('.test.js') || i.endsWith('.spec.ts') || i.endsWith('.spec.tsx')) && !i.includes('node_modules') && !i.includes('dist')).slice(0, 30);
    if (testFiles.length === 0) return { ok: true, tool: 'findTests', output: 'No test files found', duration: Date.now() - t0 };
    let filtered = testFiles;
    if (symbol) filtered = testFiles.filter(f => String(f).toLowerCase().includes(String(symbol).toLowerCase()));
    const display = filtered.length > 0 ? filtered : testFiles;
    return { ok: true, tool: 'findTests', output: 'Found ' + display.length + ' test files:\n' + display.map(f => '  ' + f).join('\n'), duration: Date.now() - t0 };
  } catch {
    return { ok: true, tool: 'findTests', output: 'No test files found', duration: Date.now() - t0 };
  }
}

export function runBuild(repoPath: string): ToolResult {
  return run('npm run build 2>&1 | tail -30', repoPath, 30000);
}

export function runTypecheck(repoPath: string): ToolResult {
  return run('npx tsc --noEmit 2>&1 | tail -30', repoPath, 30000);
}

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY TOOLS
// ═══════════════════════════════════════════════════════════════════

export function listDeps(repoPath: string): ToolResult {
  return run('npm ls --depth=0 2>&1', repoPath);
}

export function outdatedDeps(repoPath: string): ToolResult {
  return run('npm outdated 2>&1', repoPath);
}

export function packageInfo(repoPath: string, pkg: string): ToolResult {
  if (!pkg) return { ok: false, tool: 'packageInfo', output: '', error: 'Usage: packageInfo <pkg>', duration: 0 };
  return run('npm info ' + pkg + ' version description homepage 2>&1', repoPath);
}

export function analyzePackageJson(repoPath: string): ToolResult {
  const t0 = Date.now();
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8'));
    const deps = Object.entries(pkg.dependencies || {}).map(([k, v]) => k + '@' + v);
    const devDeps = Object.entries(pkg.devDependencies || {}).map(([k, v]) => k + '@' + v);
    const scripts = Object.entries(pkg.scripts || {}).map(([k, v]) => '  ' + k + ': ' + v);
    return {
      ok: true, tool: 'analyzePackageJson', duration: Date.now() - t0,
      output: (pkg.name || 'unnamed') + ' v' + (pkg.version || '?') + '\n\nScripts:\n' + scripts.join('\n') + '\n\nDependencies (' + deps.length + '):\n  ' + deps.join('\n  ') + '\n\nDev Dependencies (' + devDeps.length + '):\n  ' + devDeps.slice(0, 15).join('\n  '),
    };
  } catch (e: any) {
    return { ok: false, tool: 'analyzePackageJson', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SECURITY & PERFORMANCE
// ═══════════════════════════════════════════════════════════════════

export function analyzeSecurity(repoPath: string): ToolResult {
  const t0 = Date.now();
  const issues: string[] = [];
  const secrets = rg('api_key|secret|password|token|private_key|ACCESS_KEY', repoPath, '--type ts --type js');
  if (secrets) issues.push('Potential secrets:\n' + secrets.split('\n').slice(0, 8).map(s => '  ' + s).join('\n'));
  try {
    execSync('git ls-files .env .env.local', { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    issues.push('.env tracked in git — add to .gitignore!');
  } catch { /* ok */ }
  const evals = rg('eval\\(', repoPath, '--type ts --type js');
  if (evals) issues.push('eval() usage:\n' + evals.split('\n').slice(0, 5).map(s => '  ' + s).join('\n'));
  const xss = rg('dangerouslySetInnerHTML', repoPath, '--type tsx --type ts');
  if (xss) issues.push('dangerouslySetInnerHTML:\n' + xss.split('\n').slice(0, 5).map(s => '  ' + s).join('\n'));
  return {
    ok: true, tool: 'analyzeSecurity', duration: Date.now() - t0,
    output: issues.length > 0 ? issues.join('\n\n') : 'No obvious security issues detected',
  };
}

export function analyzePerformance(repoPath: string): ToolResult {
  const t0 = Date.now();
  const issues: string[] = [];
  try {
    const large = execSync('find . -type f -size +100k -name "*.ts" -o -name "*.tsx" -o -name "*.js" | grep -v node_modules | grep -v dist | grep -v .next | head -10', {
      cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim().split('\n').filter(Boolean);
    if (large.length) issues.push('Large files (>100KB):\n' + large.map(f => '  ' + f).join('\n'));
  } catch { /* ok */ }
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const bigComponents = items.filter(i => typeof i === 'string' && (i.endsWith('.tsx') || i.endsWith('.jsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next'))
      .map(f => ({ file: f as string, lines: readFileSync(join(repoPath, f as string), 'utf-8').split('\n').length }))
      .filter(f => f.lines > 200)
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 5);
    if (bigComponents.length) issues.push('Large components (>200 lines):\n' + bigComponents.map(f => '  ' + f.file + ' (' + f.lines + ' lines)').join('\n'));
  } catch { /* ok */ }
  return {
    ok: true, tool: 'analyzePerformance', duration: Date.now() - t0,
    output: issues.length > 0 ? issues.join('\n\n') : 'No obvious performance issues detected',
  };
}

// ═══════════════════════════════════════════════════════════════════
// SPECIALIZED CODING TOOLS
// ═══════════════════════════════════════════════════════════════════

export function callChain(repoPath: string, symbol: string): ToolResult {
  if (!symbol) return { ok: false, tool: 'callChain', output: '', error: 'Usage: callChain <symbol>', duration: 0 };
  const t0 = Date.now();
  const chain: string[] = [];
  const visited = new Set<string>();
  function trace(name: string, depth: number) {
    if (depth > 5 || visited.has(name) || chain.length > 30) return;
    visited.add(name);
    const callers = rg(name, repoPath, '--type ts --type tsx --type js');
    if (callers) {
      const files = callers.split('\n').filter(l => !l.includes('import') && !l.includes('//')).slice(0, 5);
      for (const f of files) {
        chain.push('  '.repeat(depth) + f);
        const match = f.match(/(?:function|const|let|var)\s+(\w+)/);
        if (match && match[1] !== name) trace(match[1], depth + 1);
      }
    }
  }
  trace(symbol, 0);
  return {
    ok: true, tool: 'callChain', duration: Date.now() - t0,
    output: chain.length > 0 ? 'Call chain for "' + symbol + '":\n' + chain.join('\n') : 'No callers found for "' + symbol + '"',
  };
}

export function findImplementations(repoPath: string, name: string): ToolResult {
  if (!name) return { ok: false, tool: 'findImplementations', output: '', error: 'Usage: findImplementations <interfaceName>', duration: 0 };
  const t0 = Date.now();
  const results: string[] = [];
  const impl = rg('implements.*' + name, repoPath, '--type ts --type tsx');
  if (impl) results.push(...impl.split('\n').slice(0, 10));
  const ext = rg('extends\\s+' + name, repoPath, '--type ts --type tsx');
  if (ext) results.push(...ext.split('\n').slice(0, 10));
  const py = rg('class\\s+\\w+\\(.*' + name, repoPath, '--type py');
  if (py) results.push(...py.split('\n').slice(0, 10));
  const java = rg('(implements|extends).*' + name, repoPath, '--type java');
  if (java) results.push(...java.split('\n').slice(0, 10));
  return {
    ok: true, tool: 'findImplementations', duration: Date.now() - t0,
    output: results.length > 0
      ? 'Implementations of "' + name + '":\n' + results.map(r => '  ' + r).join('\n')
      : 'No implementations of "' + name + '" found',
  };
}

export function findUsages(repoPath: string, symbol: string): ToolResult {
  if (!symbol) return { ok: false, tool: 'findUsages', output: '', error: 'Usage: findUsages <symbol>', duration: 0 };
  const t0 = Date.now();
  const usages = rg(symbol, repoPath);
  if (!usages) return { ok: true, tool: 'findUsages', output: 'No usages of "' + symbol + '" found', duration: Date.now() - t0 };
  const lines = usages.split('\n').slice(0, 25);
  return {
    ok: true, tool: 'findUsages', duration: Date.now() - t0,
    output: 'Usages of "' + symbol + '" (' + lines.length + ' shown):\n' + lines.join('\n'),
  };
}

export function dataFlow(repoPath: string, symbol: string): ToolResult {
  if (!symbol) return { ok: false, tool: 'dataFlow', output: '', error: 'Usage: dataFlow <symbol>', duration: 0 };
  const t0 = Date.now();
  const flows: string[] = [];
  const returns = rg('return.*' + symbol, repoPath, '--type ts --type tsx');
  if (returns) flows.push('Returns:', ...returns.split('\n').slice(0, 5).map(r => '  ' + r));
  const callers = rg(symbol + '\\(', repoPath, '--type ts --type tsx --type js');
  if (callers) flows.push('\nCalled by:', ...callers.split('\n').slice(0, 10).map(r => '  ' + r));
  return {
    ok: true, tool: 'dataFlow', duration: Date.now() - t0,
    output: flows.length > 0 ? 'Data flow for "' + symbol + '":\n' + flows.join('\n') : 'No data flow patterns found for "' + symbol + '"',
  };
}

export function complexity(repoPath: string, filePath: string): ToolResult {
  if (!filePath) return { ok: false, tool: 'complexity', output: '', error: 'Usage: complexity <path>', duration: 0 };
  const t0 = Date.now();
  try {
    const content = readFileSync(join(repoPath, filePath), 'utf-8');
    const lines = content.split('\n');
    let cc = 1;
    const highPoints: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\b(if|else if|elif)\b/.test(line)) cc++;
      if (/\b(for|while|do)\b/.test(line)) cc++;
      if (/\b(case)\b/.test(line)) cc++;
      if (/&&|\|\|/.test(line)) cc += (line.match(/&&|\|\|/g) || []).length;
      if (/&&.*&&|\|\|.*\|\|/.test(line)) highPoints.push('  Line ' + (i+1) + ': ' + line.trim().slice(0, 80));
    }
    const verdict = cc <= 5 ? 'Simple' : cc <= 10 ? 'Moderate' : cc <= 20 ? 'Complex' : 'Very Complex';
    const funcs = (content.match(/function|const\s+\w+\s*=\s*(async\s+)?\(/g) || []).length;
    return {
      ok: true, tool: 'complexity', duration: Date.now() - t0,
      output: 'Complexity: ' + filePath + '\n  Cyclomatic: ' + cc + ' (' + verdict + ')\n  Lines: ' + lines.length + '\n  Functions: ' + funcs + (highPoints.length > 0 ? '\n\nHigh complexity:\n' + highPoints.join('\n') : ''),
    };
  } catch (e: any) {
    return { ok: false, tool: 'complexity', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

export function findDeadCode(repoPath: string): ToolResult {
  const t0 = Date.now();
  const dead: string[] = [];
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const tsFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next') && !i.includes('.d.ts')).slice(0, 50) as string[];
    for (const file of tsFiles) {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const exports = content.match(/export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/g);
      if (!exports) continue;
      for (const exp of exports) {
        const name = exp.match(/export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/)?.[1];
        if (!name || name.length < 3) continue;
        const usages = rg(name, repoPath, '--glob "!' + file + '"');
        if (!usages || usages.split('\n').length < 2) {
          dead.push('  ' + file + ': export ' + name);
        }
      }
    }
  } catch { /* ok */ }
  return {
    ok: true, tool: 'findDeadCode', duration: Date.now() - t0,
    output: dead.length > 0
      ? 'Potential dead code (' + dead.length + ' unused exports):\n' + dead.slice(0, 20).join('\n')
      : 'No obvious dead code found',
  };
}

export function generateTest(repoPath: string, symbol: string): ToolResult {
  if (!symbol) return { ok: false, tool: 'generateTest', output: '', error: 'Usage: generateTest <symbolName>', duration: 0 };
  const t0 = Date.now();
  const match = rg('function ' + symbol + '\\(', repoPath, '--type ts');
  const sig = match ? match.split('\n')[0] : 'function ' + symbol + '(...)';
  const params = sig.match(/\(([^)]*)\)/)?.[1] || '';
  const testCode = [
    "import { describe, it, expect } from 'vitest';",
    "import { " + symbol + " } from './" + symbol + "';",
    '',
    "describe('" + symbol + "', () => {",
    "  it('should handle normal input', () => {",
    "    // TODO: provide test values",
    "    const result = " + symbol + "();",
    "    expect(result).toBeDefined();",
    "  });",
    '',
    "  it('should handle edge cases', () => {",
    "    // TODO: add edge cases",
    "  });",
    "});",
  ].join('\n');
  return {
    ok: true, tool: 'generateTest', duration: Date.now() - t0,
    output: 'Test skeleton for ' + symbol + ':\n\n' + testCode + '\n\nWrite to a .test.ts file and fill in TODOs.',
  };
}

export function refactorSuggest(repoPath: string, filePath?: string): ToolResult {
  const t0 = Date.now();
  const suggestions: string[] = [];
  const files = filePath ? [filePath] : readdirSync(repoPath, { recursive: true })
    .filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next'))
    .slice(0, 30) as string[];
  for (const file of files) {
    try {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const lines = content.split('\n');
      if (lines.length > 300) suggestions.push(file + ': ' + lines.length + ' lines — consider splitting');
      const todos = lines.filter(l => /TODO|FIXME|HACK|XXX/.test(l));
      if (todos.length > 3) suggestions.push(file + ': ' + todos.length + ' TODO/FIXME — address or track');
      const fileLogs = (content.match(/console\.log/g) || []).length;
      if (fileLogs > 5) suggestions.push(file + ': ' + fileLogs + ' console.log — remove or use logger');
      const anys = (content.match(/:\s*any\b/g) || []).length;
      if (anys > 3) suggestions.push(file + ': ' + anys + ' ": any" types — replace with proper types');
    } catch { /* skip */ }
  }
  return {
    ok: true, tool: 'refactorSuggest', duration: Date.now() - t0,
    output: suggestions.length > 0
      ? 'Refactoring suggestions (' + suggestions.length + '):\n' + suggestions.slice(0, 15).map(s => '  ' + s).join('\n')
      : 'No obvious refactoring opportunities found',
  };
}

// ═══════════════════════════════════════════════════════════════════
// ARCHITECTURE TOOLS
// ═══════════════════════════════════════════════════════════════════

export function callGraph(repoPath: string): ToolResult {
  const t0 = Date.now();
  const graph: string[] = [];
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const tsFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next')).slice(0, 50) as string[];
    for (const file of tsFiles) {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const imports = content.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/g);
      if (imports) {
        const local = imports.filter(i => i.includes('./') || i.includes('../'));
        if (local.length > 0) {
          graph.push('\n' + file + ':');
          for (const imp of local.slice(0, 5)) {
            const path = imp.match(/from\s+['"]([^'"]+)['"]/)?.[1];
            if (path) graph.push('  -> ' + path);
          }
        }
      }
    }
  } catch { /* ok */ }
  return {
    ok: true, tool: 'callGraph', duration: Date.now() - t0,
    output: graph.length > 0 ? 'Call graph (local imports):' + graph.join('\n') : 'No call graph found',
  };
}

export function dependencyGraph(repoPath: string, modulePath: string): ToolResult {
  if (!modulePath) return { ok: false, tool: 'dependencyGraph', output: '', error: 'Usage: dependencyGraph <file>', duration: 0 };
  const t0 = Date.now();
  const graph: string[] = [];
  try {
    const content = readFileSync(join(repoPath, modulePath), 'utf-8');
    const imports = content.match(/from\s+['"]([^'"]+)['"]/g) || [];
    graph.push(modulePath + ' depends on:');
    for (const imp of imports) {
      const path = imp.match(/from\s+['"]([^'"]+)['"]/)?.[1];
      if (path) graph.push('  ' + (path.startsWith('.') ? 'local' : 'external') + ': ' + path);
    }
    const shortName = basename(modulePath, extname(modulePath));
    const importers = rg('import.*' + shortName, repoPath, '--type ts --type tsx');
    if (importers) {
      graph.push('\nImported by:');
      for (const imp of importers.split('\n').slice(0, 10)) graph.push('  ' + imp);
    }
  } catch (e: any) {
    return { ok: false, tool: 'dependencyGraph', output: '', error: e.message, duration: Date.now() - t0 };
  }
  return { ok: true, tool: 'dependencyGraph', duration: Date.now() - t0, output: graph.join('\n') };
}

export function apiDocs(repoPath: string, filePath: string): ToolResult {
  if (!filePath) return { ok: false, tool: 'apiDocs', output: '', error: 'Usage: apiDocs <path>', duration: 0 };
  const t0 = Date.now();
  try {
    const content = readFileSync(join(repoPath, filePath), 'utf-8');
    const lines = content.split('\n');
    const docs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('export') && line.includes('function')) {
        const m = line.match(/function\s+(\w+)/);
        if (m) docs.push('### ' + m[1] + '()');
      }
      if (line.includes('export') && (line.includes('interface') || line.includes('type '))) {
        const m = line.match(/(?:interface|type)\s+(\w+)/);
        if (m) docs.push('### ' + m[1]);
      }
      if (line.match(/\.(get|post|put|delete|patch)\s*\(/)) {
        const m = line.match(/\.(get|post|put|delete|patch)/);
        const p = line.match(/['"`]([^'"`]+)['"`]/);
        if (m && p) docs.push('### ' + m[1].toUpperCase() + ' ' + p[1]);
      }
    }
    return {
      ok: true, tool: 'apiDocs', duration: Date.now() - t0,
      output: docs.length > 0 ? 'API docs for ' + filePath + ':\n\n' + docs.join('\n') : 'No API documentation found in ' + filePath,
    };
  } catch (e: any) {
    return { ok: false, tool: 'apiDocs', output: '', error: e.message, duration: Date.now() - t0 };
  }
}

export function layeringViolation(repoPath: string): ToolResult {
  const t0 = Date.now();
  const violations: string[] = [];
  const uiToDb = rg('import.*from.*(db|store|prisma|knex|sequelize|mongoose)', repoPath, "--glob 'components/**' --glob 'pages/**' --glob 'app/**'");
  if (uiToDb) violations.push('UI -> DB direct import:\n' + uiToDb.split('\n').slice(0, 5).map(s => '  ' + s).join('\n'));
  const clientToServer = rg('import.*from.*(server|api|middleware)', repoPath, "--glob 'components/**' --glob 'pages/**'");
  if (clientToServer) violations.push('Client -> Server import:\n' + clientToServer.split('\n').slice(0, 5).map(s => '  ' + s).join('\n'));
  return {
    ok: true, tool: 'layeringViolation', duration: Date.now() - t0,
    output: violations.length > 0 ? 'Layering violations (' + violations.length + '):\n' + violations.join('\n\n') : 'No layering violations detected',
  };
}

export function hotPath(repoPath: string): ToolResult {
  const t0 = Date.now();
  const paths: string[] = [];
  const entries = rg('export default|module.exports|createServer|listen\\(', repoPath, '--type ts --type js');
  if (entries) {
    paths.push('Entry points:');
    paths.push(...entries.split('\n').slice(0, 5).map(s => '  ' + s));
  }
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const tsFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next')).slice(0, 100) as string[];
    const importCount = new Map<string, number>();
    for (const file of tsFiles) {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const imports = content.match(/from\s+['"]([^'"]+)['"]/g) || [];
      for (const imp of imports) {
        const path = imp.match(/from\s+['"]([^'"]+)['"]/)?.[1];
        if (path && path.startsWith('.')) importCount.set(path, (importCount.get(path) || 0) + 1);
      }
    }
    const top = [...importCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length > 0) {
      paths.push('\nMost imported (critical paths):');
      for (const [path, count] of top) paths.push('  ' + count + 'x ' + path);
    }
  } catch { /* ok */ }
  return {
    ok: true, tool: 'hotPath', duration: Date.now() - t0,
    output: paths.length > 0 ? paths.join('\n') : 'No hot paths detected',
  };
}

export function circularDeps(repoPath: string): ToolResult {
  const t0 = Date.now();
  const cycles: string[] = [];
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const tsFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next')).slice(0, 80) as string[];
    const adj = new Map<string, Set<string>>();
    for (const file of tsFiles) {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const imports = content.match(/from\s+['"]([^'"]+)['"]/g) || [];
      const from = file.replace(/\\/g, '/');
      for (const imp of imports) {
        const path = imp.match(/from\s+['"]([^'"]+)['"]/)?.[1];
        if (path && path.startsWith('.')) {
          const to = join(dirname(from), path).replace(/\\/g, '/');
          if (!adj.has(from)) adj.set(from, new Set());
          adj.get(from)!.add(to);
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    function dfs(node: string) {
      if (cycles.length > 10) return;
      visiting.add(node);
      stack.push(node);
      for (const next of adj.get(node) || []) {
        if (visiting.has(next)) {
          const idx = stack.indexOf(next);
          if (idx >= 0) cycles.push('  ' + stack.slice(idx).join(' -> ') + ' -> ' + next);
        } else if (!visited.has(next)) {
          dfs(next);
        }
      }
      stack.pop();
      visiting.delete(node);
      visited.add(node);
    }
    for (const file of tsFiles) {
      const f = file.replace(/\\/g, '/');
      if (!visited.has(f)) dfs(f);
      if (cycles.length > 10) break;
    }
  } catch { /* ok */ }
  return {
    ok: true, tool: 'circularDeps', duration: Date.now() - t0,
    output: cycles.length > 0 ? 'Circular dependencies (' + cycles.length + '):\n' + cycles.join('\n') : 'No circular dependencies detected',
  };
}

export function godModule(repoPath: string): ToolResult {
  const t0 = Date.now();
  const gods: string[] = [];
  try {
    const items = readdirSync(repoPath, { recursive: true });
    const tsFiles = items.filter(i => typeof i === 'string' && (i.endsWith('.ts') || i.endsWith('.tsx')) && !i.includes('node_modules') && !i.includes('dist') && !i.includes('.next')).slice(0, 100) as string[];
    for (const file of tsFiles) {
      const content = readFileSync(join(repoPath, file), 'utf-8');
      const lines = content.split('\n');
      const exports = (content.match(/export /g) || []).length;
      const functions = (content.match(/function|const\s+\w+\s*=\s*(async\s+)?\(/g) || []).length;
      const classes = (content.match(/class /g) || []).length;
      const score = exports + functions * 2 + classes * 3;
      if (score >= 15 || lines.length > 400) {
        gods.push('  ' + file + ': ' + lines.length + ' lines, ' + exports + ' exports, ' + functions + ' functions');
      }
    }
  } catch { /* ok */ }
  return {
    ok: true, tool: 'godModule', duration: Date.now() - t0,
    output: gods.length > 0
      ? 'God modules (high responsibility):\n' + gods.sort().reverse().join('\n') + '\n\nConsider splitting into smaller, focused modules.'
      : 'No god modules detected',
  };
}

export function findAPIs(repoPath: string): ToolResult {
  const t0 = Date.now();
  const apis: string[] = [];
  const routes = rg('\\.(get|post|put|delete|patch|all)\\(', repoPath, '--type ts --type tsx --type js');
  if (routes) apis.push(...routes.split('\n').slice(0, 20));
  const handlers = rg('export.*function.*(GET|POST|PUT|DELETE|PATCH)', repoPath, '--type ts --type tsx');
  if (handlers) apis.push(...handlers.split('\n').slice(0, 10));
  return {
    ok: true, tool: 'findAPIs', duration: Date.now() - t0,
    output: apis.length > 0 ? 'API endpoints:\n' + apis.map(a => '  ' + a).join('\n') : 'No API endpoints found',
  };
}

export function findDBAccess(repoPath: string): ToolResult {
  const t0 = Date.now();
  const access: string[] = [];
  const patterns: [string, string][] = [
    ['Prisma', 'prisma\\.'],
    ['SQL', 'SELECT|INSERT|UPDATE|DELETE|CREATE TABLE'],
    ['Mongoose', 'mongoose|Schema\\('],
    ['Knex', 'knex\\('],
    ['SQLite', 'sqlite|better-sqlite'],
    ['Drizzle', 'drizzle'],
  ];
  for (const [name, pattern] of patterns) {
    const results = rg(pattern, repoPath, '--type ts --type tsx --type js --type sql');
    if (results) {
      access.push(name + ':');
      access.push(...results.split('\n').slice(0, 5).map(s => '  ' + s));
      access.push('');
    }
  }
  return {
    ok: true, tool: 'findDBAccess', duration: Date.now() - t0,
    output: access.length > 0 ? 'Database access patterns:\n' + access.join('\n') : 'No database access patterns found',
  };
}

// ═══════════════════════════════════════════════════════════════════
// TOOL ROUTER
// ═══════════════════════════════════════════════════════════════════

export function executeTool(toolCmd: string, repoPath: string): ToolResult {
  const parts = toolCmd.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'readFile': return readFile(repoPath, args[0], args[1] ? parseInt(args[1]) : undefined, args[2] ? parseInt(args[2]) : undefined);
    case 'searchFiles': return searchFiles(repoPath, args[0] || '*');
    case 'grepCode': return grepCode(repoPath, args.join(' '));
    case 'countLines': return countLines(repoPath, args[0]);
    case 'dirTree': return dirTree(repoPath, args[0] ? parseInt(args[0]) : undefined);
    case 'gitLog': return gitLog(repoPath, args[0], args[1] ? parseInt(args[1]) : undefined);
    case 'gitBlame': return gitBlame(repoPath, args[0], args[1] ? parseInt(args[1]) : undefined, args[2] ? parseInt(args[2]) : undefined);
    case 'gitDiff': return gitDiff(repoPath, args[0]);
    case 'gitStatus': return gitStatus(repoPath);
    case 'gitBranches': return gitBranches(repoPath);
    case 'gitDiffFull': return gitDiffFull(repoPath, args[0]);
    case 'runTests': return runTests(repoPath, args[0]);
    case 'findTests': return findTests(repoPath, args[0]);
    case 'runBuild': return runBuild(repoPath);
    case 'runTypecheck': return runTypecheck(repoPath);
    case 'listDeps': return listDeps(repoPath);
    case 'outdatedDeps': return outdatedDeps(repoPath);
    case 'packageInfo': return packageInfo(repoPath, args[0]);
    case 'analyzePackageJson': return analyzePackageJson(repoPath);
    case 'analyzeSecurity': return analyzeSecurity(repoPath);
    case 'analyzePerformance': return analyzePerformance(repoPath);
    case 'callChain': return callChain(repoPath, args.join(' '));
    case 'findImplementations': return findImplementations(repoPath, args.join(' '));
    case 'findUsages': return findUsages(repoPath, args.join(' '));
    case 'dataFlow': return dataFlow(repoPath, args.join(' '));
    case 'complexity': return complexity(repoPath, args[0]);
    case 'findDeadCode': return findDeadCode(repoPath);
    case 'generateTest': return generateTest(repoPath, args.join(' '));
    case 'refactorSuggest': return refactorSuggest(repoPath, args[0]);
    case 'callGraph': return callGraph(repoPath);
    case 'dependencyGraph': return dependencyGraph(repoPath, args[0]);
    case 'apiDocs': return apiDocs(repoPath, args[0]);
    case 'layeringViolation': return layeringViolation(repoPath);
    case 'hotPath': return hotPath(repoPath);
    case 'circularDeps': return circularDeps(repoPath);
    case 'godModule': return godModule(repoPath);
    case 'findAPIs': return findAPIs(repoPath);
    case 'findDBAccess': return findDBAccess(repoPath);
    // Web & Terminal tools
    case 'webSearch': return webSearch(args.join(' '));
    case 'fetchUrl': return fetchUrl(args[0]);
    case 'runCommand': return runCommandTool(repoPath, args.join(' '));
    case 'installPackage': return installPackage(repoPath, args.join(' '));
    default:
      return { ok: false, tool: cmd, output: '', error: 'Unknown tool: ' + cmd + '. Type /help for available tools.', duration: 0 };
  }
}
