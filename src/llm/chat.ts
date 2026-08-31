// Autonomous agent with Claude Code style step-by-step narration.
// Shows every step: planning, tool execution, learning, synthesis.

import * as readline from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { GraphStore } from '../core/store.js';
import { chatComplete, loadLLMConfig, type ChatMessage } from './client.js';
import {
  readFile, searchFiles, grepCode, gitLog, gitBlame, gitDiff, gitStatus,
  gitBranches, runTests, findTests, runBuild, runTypecheck, listDeps,
  outdatedDeps, packageInfo, countLines, analyzePackageJson,
  dirTree, analyzePerformance, analyzeSecurity, executeTool,
  callChain, findImplementations, findUsages, dataFlow, complexity,
  findDeadCode, generateTest, refactorSuggest, callGraph, dependencyGraph,
  apiDocs, layeringViolation, hotPath, circularDeps, godModule, findAPIs, findDBAccess,
} from './tools.js';
import { webSearch, fetchUrl, runCommand as runCmd, installPackage } from './web-tools.js';

const MAX_ROUNDS = 4;
const MAX_TOOLS = 5;
const MAX_OUTPUT = 2500;

const E = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
  orange: '\x1b[38;2;202;62;28m', white: '\x1b[37m', italic: '\x1b[3m',
};

function runArchmap(cmd: string, cwd: string): string {
  try { return execSync('archmap ' + cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }); } catch { return ''; }
}

function extractToolCalls(text: string): string[] {
  const calls: string[] = [];
  const re = /\[(?:TOOL|GRAPH|CODE|CMD):\s*(.+?)\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) calls.push(m[1].trim());
  return calls;
}

function extractSteps(text: string): string[] {
  // Extract the agent's plan/steps from its reasoning
  const steps: string[] = [];
  // Match numbered steps or bullet points in reasoning
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match patterns like "1. I'll run..." or "- First, I'll..." or "I'll run X"
    if (/^\d+[\.\)]\s/.test(trimmed) || /^[-*]\s/.test(trimmed)) {
      steps.push(trimmed.replace(/^[\d\.\)*-]+\s*/, ''));
    } else if (/^I(?:'ll| will| plan to)\s/i.test(trimmed)) {
      steps.push(trimmed);
    }
  }
  return steps.slice(0, 5);
}

function extractLearned(text: string, toolName: string): string {
  // Extract what the agent learned from a tool result
  const parts = text.split(/(?:Based on|From the|The results show|The output|I can see|This shows|The data)/i);
  if (parts.length > 1) return parts[1].slice(0, 120).trim();
  return '';
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n... (truncated)' : s;
}

// ─── UI ───────────────────────────────────────────────────────────
const LOGO = `\n${E.orange}${E.bold}    \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${E.reset}\n${E.orange}${E.bold}    \u2551${E.reset}   ${E.orange}${E.bold} __  __  __    __    __  __  __  __${E.reset}     ${E.orange}${E.bold}\u2551${E.reset}\n${E.orange}${E.bold}    \u2551${E.reset}   ${E.orange}${E.bold}/ _)/  \\\\/  | / / /\\\\ / _ \\\\ /  \\\\/  |/ /${E.reset}   ${E.orange}${E.bold}\u2551${E.reset}\n${E.orange}${E.bold}    \u2551${E.reset}   ${E.orange}${E.bold}\\\\__ \\\\\\\\ /\\\\/ /  |/ / /  \\\\  __/ /\\\\/ /   /${E.reset}  ${E.orange}${E.bold}\u2551${E.reset}\n${E.orange}${E.bold}    \u2551${E.reset}   ${E.orange}${E.bold}(___/__/\\\\__/__/\\\\_/\\\\_/\\\\___/_/  \\\\_/\\\\_/${E.reset}   ${E.orange}${E.bold}\u2551${E.reset}\n${E.orange}${E.bold}    \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${E.reset}\n${E.dim}               architecture mapper \u2014 agent mode${E.reset}`;

function statusBar(model: string, provider: string, nodes: number, edges: number) {
  return E.dim + '\u2500'.repeat(56) + E.reset + '\n  ' + E.dim + 'model' + E.reset + ' ' + E.bold + model + E.reset + '  ' + E.dim + '\u00b7' + E.reset + '  ' + E.dim + 'via' + E.reset + ' ' + E.cyan + provider + E.reset + '  ' + E.dim + '\u00b7' + E.reset + '  ' + E.dim + 'graph' + E.reset + ' ' + E.bold + nodes + E.reset + ' ' + E.dim + 'nodes' + E.reset + ' ' + E.dim + '\u00b7' + E.reset + ' ' + E.bold + edges + E.reset + ' ' + E.dim + 'edges' + E.reset;
}

function userMark() { return E.magenta + E.bold + '> you' + E.reset; }
function aiMark() { return E.orange + E.bold + '> arch' + E.reset; }

// Claude Code style step indicators
function stepPlan(n: number, text: string) {
  return '  ' + E.dim + E.blue + (n + 1) + '.' + E.reset + ' ' + E.white + text + E.reset;
}
function stepRunning(tool: string) {
  return '  ' + E.cyan + '\u27f3' + E.reset + ' ' + E.blue + tool + E.reset + ' ' + E.dim + '...' + E.reset;
}
function stepDone(tool: string, dur: number, learned?: string) {
  const durStr = ' ' + E.dim + '(' + dur + 'ms)' + E.reset;
  const learnedStr = learned ? '\n  ' + E.dim + '\u251c\u2500 ' + learned.slice(0, 100) + E.reset : '';
  return '  ' + E.green + '\u2713' + E.reset + ' ' + E.blue + tool + E.reset + durStr + learnedStr;
}
function stepError(tool: string, err: string) {
  return '  ' + E.red + '\u2717' + E.reset + ' ' + E.blue + tool + E.reset + ' ' + E.dim + E.red + err.slice(0, 80) + E.reset;
}

// ─── Execute Tool ─────────────────────────────────────────────────
function execTool(toolCmd: string, repoPath: string): string {
  try {
    const cmd = toolCmd.trim().split(/\s+/)[0];
    const archmapCmds = ['impact', 'explain', 'search', 'diff', 'health', 'summary', 'insights', 'trace', 'tests', 'flow', 'plan_change', 'depends-on', 'where-used', 'pin', 'sync'];
    if (archmapCmds.includes(cmd)) return runArchmap(toolCmd, repoPath);
    if (cmd === 'webSearch') return webSearch(toolCmd.replace(/^webSearch\s*/, '')).output;
    if (cmd === 'fetchUrl') return fetchUrl(toolCmd.replace(/^fetchUrl\s*/, '')).output;
    if (cmd === 'runCommand') return runCmd(repoPath, toolCmd.replace(/^runCommand\s*/, '')).output;
    if (cmd === 'installPackage') return installPackage(repoPath, toolCmd.replace(/^installPackage\s*/, '')).output;
    const result = executeTool(toolCmd, repoPath);
    return result.ok ? result.output : (result.error || 'Tool failed');
  } catch (e: any) { return 'Error: ' + e.message?.slice(0, 200); }
}

// ─── System Prompt ────────────────────────────────────────────────
function buildSystemPrompt(project: string, summary: string, topFn: string[], topConn: string[], svc: string[], tbl: string[], api: string[], ext: string[], tests: string[], health: string[], seed: string): string {
  const fnList = topFn.length ? topFn.slice(0, 15).map(f => '  - ' + f).join('\n') : '  (none)';
  const connList = topConn.length ? topConn.map(c => '  - ' + c).join('\n') : '  (none)';
  const healthBlock = health.length ? '\nHealth issues:\n' + health.map(h => '  - ' + h).join('\n') : '';
  const seedBlock = seed ? '\nSeed:\n' + seed.slice(0, 500) : '';

  return 'You are Arch \u2014 an autonomous expert software engineer for the "' + project + '" codebase. You can read code, search the web, run commands, analyze architecture.\n\n' +

    '## HOW TO WORK\n' +
    '1. Explain what you plan to do and why\n' +
    '2. Run tools with [TOOL: command]\n' +
    '3. Briefly state what you learned from each tool\n' +
    '4. Give a clear final answer\n\n' +

    '## WHEN NOT SURE\n' +
    '- Infer what the user wants and do it\n' +
    '- Use tools to find info\n' +
    '- Ask user ONE question if truly stuck\n' +
    '- If tool fails, try different approach\n\n' +

    '## CODEBASE\n' + summary + '\n\n' +
    '## KEY FUNCTIONS\n' + fnList + '\n\n' +
    '## MOST CONNECTED\n' + connList + '\n\n' +
    '## COMPONENTS\n' +
    'Services: ' + (svc.length ? svc.join(', ') : 'none') + '\n' +
    'Tables: ' + (tbl.length ? tbl.join(', ') : 'none') + '\n' +
    'APIs: ' + (api.length ? api.join(', ') : 'none') + '\n' +
    'Externals: ' + (ext.length ? ext.join(', ') : 'none') + '\n' +
    'Tests: ' + (tests.length ? tests.slice(0, 10).join(', ') : 'none') + '\n' +
    'Health: ' + (health.length ? health.join('; ') : 'clean') + healthBlock + seedBlock + '\n\n' +

    '## YOUR TOOLS\n' +
    'Output [TOOL: command] to run any tool. You can run multiple tools at once.\n\n' +

    'Graph: impact, explain, search, diff, insights, summary, trace, tests, flow, plan_change, depends-on, where-used, health\n\n' +

    'Code: readFile, searchFiles, grepCode, countLines, dirTree\n' +
    'Git: gitLog, gitBlame, gitDiff, gitStatus, gitBranches\n' +
    'Dev: runTests, findTests, runBuild, runTypecheck\n' +
    'Deps: listDeps, outdatedDeps, packageInfo, analyzePackageJson\n' +
    'Security: analyzeSecurity, analyzePerformance\n' +
    'Coding: callChain, findImplementations, findUsages, dataFlow, complexity, findDeadCode, generateTest, refactorSuggest\n' +
    'Architecture: callGraph, dependencyGraph, apiDocs, layeringViolation, hotPath, circularDeps, godModule, findAPIs, findDBAccess\n' +
    'Web: webSearch, fetchUrl, runCommand, installPackage\n' +
    'Edit: [EDIT: path | content]\n\n' +

    '## RULES\n' +
    '- Use ONLY real names from the graph/tools. Never invent.\n' +
    '- Show file:line evidence.\n' +
    '- Max 3 tools per round, 4 rounds.\n' +
    '- For greetings, respond naturally \u2014 no tools.\n' +
    '- You decide everything. No patterns. No hardcoding.\n' +
    '- Narrate your steps clearly so the user can follow along.';
}

// ─── Build Context ────────────────────────────────────────────────
function buildContext(store: GraphStore, repoPath: string) {
  const nodes = store.listNodes(undefined, 10000);
  const counts: Record<string, number> = {};
  nodes.forEach(n => { counts[n.kind] = (counts[n.kind] || 0) + 1; });
  const topConn = nodes
    .filter(n => ['Function', 'Method', 'Class', 'API'].includes(n.kind))
    .map(n => ({ name: n.name, kind: n.kind, path: n.path, links: store.getNeighbors(n.id).length }))
    .sort((a, b) => b.links - a.links).slice(0, 10);
  let seed = '';
  const seedPath = join(repoPath, '.archmap', 'seed.yaml');
  if (existsSync(seedPath)) seed = readFileSync(seedPath, 'utf-8').slice(0, 2000);
  const health: string[] = [];
  try {
    const h = JSON.parse(execSync('archmap health --json', { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const r of (h.data || [])) if (r.status === 'warn' || r.status === 'error') health.push(r.status + ': ' + r.message);
  } catch { /* ok */ }
  const summary = [
    'Project: ' + repoPath.split(/[/\\]/).pop(),
    'Components: ' + nodes.length + ' nodes, ' + store.countEdges() + ' edges',
    'Breakdown: ' + Object.entries(counts).filter(([k]) => k !== 'File').map(([k, v]) => v + ' ' + k).join(', '),
    topConn.length ? 'Most connected: ' + topConn.map(n => n.name + ' (' + n.links + ' links)').join(', ') : '',
  ].filter(Boolean).join('\n');
  return {
    projectName: repoPath.split(/[/\\]/).pop() || 'unknown',
    nodeCount: nodes.length, edgeCount: store.countEdges(),
    topFunctions: nodes.filter(n => n.kind === 'Function').slice(0, 20).map(n => n.name + ' (' + n.path + ':' + (n.startLine || '?') + ')'),
    topConnected: topConn.map(n => n.name + ' \u2014 ' + n.kind + ' \u2014 ' + n.path + ' \u2014 ' + n.links + ' links'),
    services: nodes.filter(n => n.kind === 'Service').map(n => n.name),
    tables: nodes.filter(n => n.kind === 'Table').map(n => n.name),
    apis: nodes.filter(n => n.kind === 'API').map(n => n.name),
    externals: nodes.filter(n => n.kind === 'External').map(n => n.name),
    tests: nodes.filter(n => n.kind === 'Test').map(n => n.name + ' (' + n.path + ')'),
    seed, healthIssues: health, summary,
  };
}

// ─── Main Chat \u2014 Claude Code Style ──────────────────────────────
export async function startChat(store: GraphStore, repoPath: string): Promise<void> {
  const cfg = loadLLMConfig();
  if (!cfg.configured) {
    console.log('\n' + E.red + E.bold + '  No LLM configured.' + E.reset + '\n\n  Set your API key in ' + E.bold + '.env' + E.reset + ' to use chat.\n');
    return;
  }
  const ctx = buildContext(store, repoPath);
  const systemPrompt = buildSystemPrompt(ctx.projectName, ctx.summary, ctx.topFunctions, ctx.topConnected, ctx.services, ctx.tables, ctx.apis, ctx.externals, ctx.tests, ctx.healthIssues, ctx.seed);

  console.log(LOGO);
  console.log('');
  console.log(statusBar(cfg.strongModel, cfg.provider, ctx.nodeCount, ctx.edgeCount));
  console.log('');
  console.log('  ' + E.white + 'Ask anything. I figure out what to do on my own.' + E.reset);
  console.log('  ' + E.dim + 'Type' + E.reset + ' ' + E.bold + '/help' + E.reset + ' ' + E.dim + 'for commands,' + E.reset + ' ' + E.bold + '/quit' + E.reset + ' ' + E.dim + 'to exit.' + E.reset + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: E.orange + E.bold + 'arch' + E.reset + ' ' + E.dim + '>' + E.reset + ' ' });
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  let processing = false;
  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    processing = true;

    if (input === '/quit' || input === '/exit') { console.log('\n' + E.dim + '  Bye!' + E.reset + '\n'); rl.close(); process.exit(0); }
    if (input === '/help') {
      console.log('\n  ' + E.bold + E.white + 'Commands:' + E.reset +
        '\n    ' + E.bold + '/help' + E.reset + ', ' + E.bold + '/quit' + E.reset + ', ' + E.bold + '/diff' + E.reset + ', ' + E.bold + '/summary' + E.reset + ', ' + E.bold + '/health' + E.reset +
        '\n    ' + E.bold + '/insights' + E.reset + ', ' + E.bold + '/security' + E.reset + ', ' + E.bold + '/perf' + E.reset + ', ' + E.bold + '/tree' + E.reset + ', ' + E.bold + '/deps' + E.reset +
        '\n    ' + E.bold + '/tests' + E.reset + ', ' + E.bold + '/build' + E.reset + ', ' + E.bold + '/git' + E.reset + ', ' + E.bold + '/status' + E.reset +
        '\n\n  ' + E.dim + 'Or just ask in natural language.' + E.reset +
        '\n  ' + E.dim + 'Examples:' + E.reset +
        '\n    ' + E.cyan + '"what breaks if I change ContactSection?"' + E.reset +
        '\n    ' + E.cyan + '"search the web for react 19 features"' + E.reset +
        '\n    ' + E.cyan + '"run the tests and tell me what fails"' + E.reset +
        '\n    ' + E.cyan + '"check if this code is secure"' + E.reset +
        '\n');
      rl.prompt(); processing = false; return;
    }
    const slashMap: Record<string, string> = { '/diff': 'diff', '/summary': 'summary', '/health': 'health', '/insights': 'insights', '/security': 'analyzeSecurity', '/perf': 'analyzePerformance', '/tree': 'dirTree', '/deps': 'listDeps', '/tests': 'findTests', '/build': 'runBuild', '/status': 'gitStatus', '/git': 'gitLog' };
    if (slashMap[input]) { console.log(''); console.log(execTool(slashMap[input], repoPath)); console.log(''); rl.prompt(); processing = false; return; }

    console.log('\n' + userMark());
    console.log('  ' + E.white + input + E.reset + '\n');

    messages.push({ role: 'user', content: input });
    let lastUsage = { model: '', input_tokens: 0, output_tokens: 0, estimated_cost: 0 };

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await chatComplete({ model: cfg.strongModel, temperature: 0.4, maxTokens: 3000, messages });
      if (!result?.text) { console.log('\n  ' + E.red + 'No response' + E.reset); break; }
      lastUsage = result.usage;

      const toolCalls = extractToolCalls(result.text);

      // No tools \u2014 final answer or question
      if (toolCalls.length === 0) {
        const clean = result.text.replace(/\[(?:TOOL|GRAPH|CODE|CMD):.*?\]/g, '').trim();

        // Check if asking user a question
        if (/\?[\s]*$/.test(clean) || /would you like|shall i|should i|do you want|can you clarify/i.test(clean)) {
          console.log('\n' + aiMark());
          console.log('  ' + E.yellow + E.bold + clean + E.reset);
          let answer = '';
          try {
            answer = await new Promise<string>(r => {
              rl.question('  ' + E.orange + E.bold + 'you' + E.reset + ' ' + E.dim + '>' + E.reset + ' ', a => r(a));
            });
          } catch {
            console.log('\n' + aiMark());
            console.log('  ' + clean);
            messages.push({ role: 'assistant', content: clean });
            break;
          }
          messages.push({ role: 'assistant', content: result.text });
          messages.push({ role: 'user', content: 'User answer: ' + answer });
          continue;
        }

        // Final answer
        console.log('\n' + aiMark());
        console.log('  ' + E.white + clean + E.reset);
        messages.push({ role: 'assistant', content: clean });
        break;
      }

      // Claude Code style step-by-step execution
      const steps = extractSteps(result.text);
      if (steps.length > 0 && round === 0) {
        console.log('  ' + E.dim + E.blue + 'Plan:' + E.reset);
        steps.forEach((s, i) => console.log(stepPlan(i, s)));
        console.log('');
      }

      // Run each tool with narration
      const toolResults: string[] = [];
      let toolNum = 0;
      for (const tc of toolCalls.slice(0, MAX_TOOLS)) {
        const t0 = Date.now();
        console.log(stepRunning(tc));
        const output = execTool(tc, repoPath);
        const dur = Date.now() - t0;
        const learned = extractLearned(output, tc);
        console.log(stepDone(tc, dur, learned));
        toolResults.push('[Tool Result: ' + tc + ']\n' + truncate(output));
        toolNum++;
      }

      messages.push({ role: 'assistant', content: result.text });
      if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults.join('\n\n') });
    }

    // Force final answer
    if (messages[messages.length - 1].role === 'user') {
      console.log('\n  ' + E.dim + E.blue + 'Synthesizing...' + E.reset);
      messages.push({ role: 'user', content: 'Give your final answer now. Do NOT run more tools. Be comprehensive.' });
      const final = await chatComplete({ model: cfg.strongModel, temperature: 0.3, maxTokens: 3000, messages });
      if (final?.text) {
        console.log('\n' + aiMark());
        console.log('  ' + E.white + final.text.replace(/\[(?:TOOL|GRAPH|CODE|CMD):.*?\]/g, '').trim() + E.reset);
        lastUsage = final.usage;
      }
    }

    console.log('\n  ' + E.dim + lastUsage.model + ' \u00b7 ' + lastUsage.input_tokens + '+' + lastUsage.output_tokens + ' tokens \u00b7 $' + lastUsage.estimated_cost.toFixed(4) + E.reset + '\n');
    processing = false;
    try { rl.prompt(); } catch { /* closed */ }
  });

  rl.on('close', () => { if (!processing) process.exit(0); });
}
