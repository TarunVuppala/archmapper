// Rich terminal UI — Claude Code / Codex / AntiGravity style.
// ASCII logos, status bars, tool call indicators, permission dialogs.

import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import ora from 'ora';

// ─── Colors ──────────────────────────────────────────────────────
export const c = {
  brand: chalk.hex('#ca3e1c'),
  brandBright: chalk.hex('#ec6e4c'),
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.cyan,
  muted: chalk.dim,
  dim: chalk.dim,
  node: chalk.white.bold,
  kind: chalk.hex('#ebdcb9'),
  path: chalk.gray,
  line: chalk.hex('#ca3e1c'),
  edge: chalk.hex('#a78bfa'),
  edgeType: chalk.hex('#6b21a8').bold,
  riskCritical: chalk.red.bold,
  riskHigh: chalk.hex('#f97316').bold,
  riskMedium: chalk.yellow,
  riskLow: chalk.green,
  link: chalk.cyan.underline,
  prompt: chalk.hex('#ca3e1c').bold,
  user: chalk.hex('#6b21a8').bold,
  assistant: chalk.hex('#ca3e1c').bold,
  tool: chalk.hex('#0284c7').bold,
  toolResult: chalk.hex('#059669'),
  toolError: chalk.hex('#dc2626'),
  dimmed: chalk.dim.gray,
};

// ─── ASCII Art Logo ──────────────────────────────────────────────
export const LOGO = `
${c.brand('    ╔═══════════════════════════════════════╗')}
${c.brand('    ║')}  ${c.brandBright.bold(' __  __  __    __    __  __  __  __')}    ${c.brand('║')}
${c.brand('    ║')}  ${c.brandBright.bold('/ _)/  \\/  | / / /\\ / _ \\ /  \\/  |/ /')}  ${c.brand('║')}
${c.brand('    ║')}  ${c.brandBright.bold('\\__ \\ /\\/ /  |/ / /  \\  __/ /\\/ /   / ')}  ${c.brand('║')}
${c.brand('    ║')}  ${c.brandBright.bold('(___/__/\\__/__/\\_/\\_/\\___/_/  \\_/\\_/')}  ${c.brand('║')}
${c.brand('    ╚═══════════════════════════════════════╝')}
${c.dimmed('              architecture mapper')}
`.trim();

// ─── Status Bar (like Claude Code) ───────────────────────────────
export function statusBar(opts: { model?: string; provider?: string; tokens?: number; cost?: number; tools?: string[] }) {
  const parts: string[] = [];
  if (opts.model) parts.push(`${c.muted('model')} ${c.node(opts.model)}`);
  if (opts.provider) parts.push(`${c.muted('via')} ${c.info(opts.provider)}`);
  if (opts.tokens) parts.push(`${c.muted('tokens')} ${c.node(String(opts.tokens))}`);
  if (opts.cost !== undefined) parts.push(`${c.muted('cost')} ${c.node('$' + opts.cost.toFixed(4))}`);
  if (opts.tools?.length) parts.push(`${c.muted('tools')} ${c.tool(opts.tools.join(', '))}`);
  return `  ${c.dimmed('─'.repeat(50))}\n  ${parts.join(`  ${c.dimmed('·')}  `)}`;
}

// ─── Tool Call Indicator (like Claude Code) ──────────────────────
export function toolCallIndicator(tool: string, status: 'running' | 'done' | 'error', result?: string) {
  const icon = status === 'running' ? c.tool('⟳') : status === 'done' ? c.toolResult('✓') : c.toolError('✗');
  const label = c.tool(tool);
  if (status === 'running') return `  ${icon} ${label}`;
  if (status === 'error') return `  ${icon} ${c.toolError(tool)} ${c.dimmed(result || '')}`;
  return `  ${icon} ${label}`;
}

// ─── Permission Dialog ───────────────────────────────────────────
export function permissionDialog(action: string, target: string) {
  return boxen(
    `${c.warning('⚠  Permission Required')}\n\n` +
    `${c.node('Action:')}   ${action}\n` +
    `${c.node('Target:')}   ${c.info(target)}\n\n` +
    `${c.dimmed('Type')} ${c.node('y')} ${c.dimmed('to confirm,')} ${c.node('n')} ${c.dimmed('to cancel')}`,
    { padding: 1, borderStyle: 'round', borderColor: 'yellow' as any }
  );
}

// ─── Boxen helpers ───────────────────────────────────────────────
export function box(content: string, opts?: { title?: string; color?: string; padding?: number }) {
  return boxen(content, {
    padding: opts?.padding ?? 1,
    margin: { top: 0, bottom: 1, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor: (opts?.color as any) || 'gray',
    title: opts?.title,
    titleAlignment: 'left',
  });
}

export function banner(title: string, subtitle?: string) {
  const lines = [c.brandBright.bold(title)];
  if (subtitle) lines.push(c.muted(subtitle));
  return box(lines.join('\n'), { color: '#ca3e1c', padding: 1 });
}

export function section(title: string, content: string) {
  return `\n${c.brand('▸')} ${c.node(title)}\n${content}`;
}

// ─── Tables ──────────────────────────────────────────────────────
export function table(headers: string[], rows: string[][]) {
  const t = new Table({
    head: headers.map(h => c.node(h)),
    style: { head: [], border: [] },
    chars: {
      'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
      'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      'left': '  ', 'left-mid': '', 'mid': '', 'mid-mid': '',
      'right': '', 'right-mid': '', 'middle': ' · ',
    },
  });
  for (const row of rows) t.push(row);
  return t.toString();
}

// ─── Risk chips ──────────────────────────────────────────────────
export function riskChip(kind: string, message: string): string {
  const icons: Record<string, string> = {
    critical: '🔴', db_write: '💾', external: '🔗',
    untested: '🧪', conflict: '⚡', churn: '📈', downstream: '↓',
  };
  const colors: Record<string, Function> = {
    critical: c.riskCritical, db_write: c.warning, external: c.info,
    untested: c.riskHigh, conflict: c.error, churn: c.warning, downstream: c.dimmed,
  };
  const icon = icons[kind] || '⚠️';
  const color = colors[kind] || c.dimmed;
  return `  ${icon} ${color(message)}`;
}

// ─── Severity badge ──────────────────────────────────────────────
export function severityBadge(severity: string): string {
  const badges: Record<string, string> = {
    low: c.riskLow(' ● LOW RISK'),
    medium: c.riskMedium(' ● MEDIUM RISK'),
    critical: c.riskCritical(' ● CRITICAL RISK'),
  };
  return badges[severity] || c.muted(' ● UNKNOWN');
}

// ─── Spinner ─────────────────────────────────────────────────────
export function spinner(text: string) {
  return ora({ text, color: 'cyan', spinner: 'dots' });
}

// ─── Node display ────────────────────────────────────────────────
const KIND_ICON: Record<string, string> = {
  Function: '⚡', Method: '⚡', Class: '📦', Interface: '🔌',
  Table: '🗄️', API: '🌐', File: '📄', External: '🔗', Test: '🧪',
  Service: '🏛️', Package: '📦', Event: '📣', Module: '📁',
};

export function nodeLine(name: string, kind: string, path?: string, line?: number) {
  const icon = KIND_ICON[kind] || '•';
  const loc = path ? ` ${c.path(path)}${line ? c.line(':' + line) : ''}` : '';
  return `  ${icon} ${c.node(name)} ${c.muted(kind)}${loc}`;
}

// ─── Why-path display ────────────────────────────────────────────
export function whyPath(steps: Array<{ from: string; to: string; edgeType: string; evidence?: { file: string; line: number } }>) {
  return steps.map((s, i) => {
    const prefix = i === 0 ? '  ▸' : '    ↓';
    const ev = s.evidence ? ` ${c.muted(s.evidence.file + ':' + s.evidence.line)}` : '';
    return `${prefix} ${c.node(s.from.split(':').pop() || s.from)} ${c.edgeType('──' + s.edgeType + '──▸')} ${c.node(s.to.split(':').pop() || s.to)}${ev}`;
  }).join('\n');
}

// ─── Progress Bar ────────────────────────────────────────────────
export function progressBar(current: number, total: number, width = 30): string {
  const pct = Math.min(1, current / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${c.tool(bar)} ${c.muted(Math.round(pct * 100) + '%')}`;
}

// ─── Clearance ───────────────────────────────────────────────────
export function clear() {
  process.stdout.write('\x1Bc');
}

// ─── Help Bar ────────────────────────────────────────────────────
export function helpBar(shortcuts: Array<{ key: string; desc: string }>) {
  const parts = shortcuts.map(s => `${c.node(s.key)} ${c.dimmed(s.desc)}`);
  return `  ${c.dimmed('─'.repeat(50))}\n  ${parts.join(`  ${c.dimmed('·')}  `)}`;
}
