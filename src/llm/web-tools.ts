// Web search, terminal execution, URL fetch — agent can access the world.

import { execSync } from 'node:child_process';
import { get } from 'node:http';
import { get as gets } from 'node:https';

export interface ToolResult {
  ok: boolean;
  tool: string;
  output: string;
  error?: string;
  duration: number;
}

/** Search the web via DuckDuckGo HTML (no API key needed) */
export function webSearch(query: string): ToolResult {
  if (!query) return { ok: false, tool: 'webSearch', output: '', error: 'Usage: webSearch <query>', duration: 0 };
  const t0 = Date.now();
  try {
    const encoded = encodeURIComponent(query);
    const cmd = 'curl -sL "https://html.duckduckgo.com/html/?q=' + encoded + '" -H "User-Agent: Mozilla/5.0" 2>&1 | head -500';
    const raw = execSync(cmd, { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    // Extract result titles and snippets
    const results: string[] = [];
    const titleMatches = raw.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/g);
    const snippetMatches = raw.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)/g);
    const titles = [...titleMatches].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 8);
    const snippets = [...snippetMatches].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 8);
    const urlMatches = raw.matchAll(/class="result__url"[^>]*>([\s\S]*?)<\/a>/g);
    const urls = [...urlMatches].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 8);
    for (let i = 0; i < titles.length; i++) {
      results.push((i + 1) + '. ' + titles[i]);
      if (urls[i]) results.push('   ' + urls[i]);
      if (snippets[i]) results.push('   ' + snippets[i].slice(0, 150));
      results.push('');
    }
    if (results.length === 0) {
      // Fallback: extract any text between tags
      const fallback = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      return { ok: true, tool: 'webSearch', output: 'Search results for "' + query + '":\n' + fallback, duration: Date.now() - t0 };
    }
    return { ok: true, tool: 'webSearch', output: 'Search results for "' + query + '":\n\n' + results.join('\n'), duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: 'webSearch', output: '', error: 'Web search failed: ' + e.message?.slice(0, 200), duration: Date.now() - t0 };
  }
}

/** Fetch and extract text from a URL */
export function fetchUrl(url: string): ToolResult {
  if (!url) return { ok: false, tool: 'fetchUrl', output: '', error: 'Usage: fetchUrl <url>', duration: 0 };
  const t0 = Date.now();
  try {
    const cmd = 'curl -sL "' + url + '" -H "User-Agent: Mozilla/5.0" --max-time 10 2>&1 | head -300';
    const raw = execSync(cmd, { encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    // Strip HTML and extract readable text
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
    if (text.length < 20) return { ok: true, tool: 'fetchUrl', output: 'Empty or blocked response from ' + url, duration: Date.now() - t0 };
    return { ok: true, tool: 'fetchUrl', output: 'Content from ' + url + ':\n\n' + text, duration: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, tool: 'fetchUrl', output: '', error: 'Fetch failed: ' + e.message?.slice(0, 200), duration: Date.now() - t0 };
  }
}

/** Run any terminal command */
export function runCommand(repoPath: string, command: string): ToolResult {
  if (!command) return { ok: false, tool: 'runCommand', output: '', error: 'Usage: runCommand <command>', duration: 0 };
  const t0 = Date.now();
  // Block dangerous commands
  const blocked = ['rm -rf /', 'mkfs', ':(){', 'dd if=', 'format c:', 'del /s'];
  if (blocked.some(b => command.includes(b))) {
    return { ok: false, tool: 'runCommand', output: '', error: 'Blocked dangerous command: ' + command, duration: 0 };
  }
  try {
    const output = execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const trimmed = output.trim().slice(0, 5000);
    return { ok: true, tool: 'runCommand', output: '$ ' + command + '\n' + (trimmed || '(no output)'), duration: Date.now() - t0 };
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.trim()?.slice(0, 2000) || '';
    const stdout = e.stdout?.toString()?.trim()?.slice(0, 2000) || '';
    return { ok: false, tool: 'runCommand', output: '$ ' + command + '\n' + (stdout || stderr || e.message?.slice(0, 500)), error: 'Command exited with code ' + e.status, duration: Date.now() - t0 };
  }
}

/** Install an npm package */
export function installPackage(repoPath: string, pkg: string): ToolResult {
  if (!pkg) return { ok: false, tool: 'installPackage', output: '', error: 'Usage: installPackage <package-name>', duration: 0 };
  return runCommand(repoPath, 'npm install ' + pkg + ' 2>&1 | tail -10');
}
