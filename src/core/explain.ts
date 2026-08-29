// Plain-language explanations of graph facts. Deterministic — no LLM required.

import type { Explanation, GraphNode, ImpactResult, WhyPath } from './types.js';
import type { GraphStore } from './store.js';

const VERB: Record<string, string> = {
  CALLS: 'calls',
  IMPORTS: 'imports',
  EXPOSES: 'is exposed as',
  CONSUMES: 'consumes',
  READS: 'reads',
  WRITES: 'writes to',
  PUBLISHES: 'publishes',
  SUBSCRIBES: 'subscribes to',
  TESTS: 'is tested by',
  DEPENDS_ON: 'depends on',
  CONTAINS: 'contains',
  IMPLEMENTS: 'implements',
  DOCUMENTS: 'is documented by',
  USES_CONFIG: 'uses config',
};

export function explainImpact(store: GraphStore, impact: ImpactResult): Explanation {
  const start = store.getNode(impact.startIds[0]);
  const name = start?.name ?? impact.startIds[0] ?? 'this component';
  const counts = impact.counts ?? ({} as Record<string, number>);
  const parts: string[] = [];
  const add = (kind: string, label: string) => {
    const n = counts[kind as keyof typeof counts] ?? 0;
    if (n > 0) parts.push(`${n} ${label}`);
  };
  add('Function', 'functions');
  add('Method', 'methods');
  add('Class', 'classes');
  add('API', 'APIs');
  add('Table', 'database tables');
  add('Service', 'services');
  add('Test', 'tests');
  add('External', 'external packages');
  add('Event', 'events');

  const direction = impact.direction === 'upstream' ? 'depends on' : 'could affect';
  const summary = parts.length > 0
    ? `Changing ${name} ${direction} ${parts.join(', ')}.`
    : `No further ${impact.direction} relationships were found for ${name}.`;

  const bullets: string[] = [];
  for (const [kind, n] of Object.entries(counts)) {
    if (n && kind !== 'File' && kind !== 'Repo') bullets.push(`${n} ${kind.toLowerCase()}${n === 1 ? '' : 's'}`);
  }

  const paths = impact.paths.slice(0, 7).map(p => formatPath(store, p));
  const risks = impact.riskChips.map(r => r.message);
  const tests = impact.testsToRun.map(id => store.getNode(id)?.name ?? id);

  const nextSteps: string[] = [];
  if (tests.length > 0) nextSteps.push(`Run the ${tests.length} related test${tests.length === 1 ? '' : 's'} before merging.`);
  else nextSteps.push('No tests are linked to this path — consider adding coverage.');
  if (counts['Table']) nextSteps.push('This path touches the database. Review schema and migrations.');
  if (counts['API']) nextSteps.push('A public API is on the path. Check contracts and consumers.');
  if (counts['External']) nextSteps.push('An external system is involved. Confirm versioned docs.');
  nextSteps.push('Edit only files inside the change plan envelope.');

  return {
    title: `If you change ${name}`,
    summary,
    bullets,
    paths,
    risks,
    tests,
    nextSteps,
  };
}

export function explainNode(store: GraphStore, node: GraphNode): Explanation {
  const out = store.getOutEdges(node.id);
  const inn = store.getInEdges(node.id);
  const callers = inn.filter(e => e.type === 'CALLS').length;
  const callees = out.filter(e => e.type === 'CALLS').length;
  const writes = out.filter(e => e.type === 'WRITES');
  const reads = out.filter(e => e.type === 'READS');
  const apis = out.filter(e => e.type === 'EXPOSES');
  const tests = inn.filter(e => e.type === 'TESTS');

  const bullets: string[] = [];
  bullets.push(`This is a ${node.kind.toLowerCase()}${node.path ? ` in ${node.path}` : ''}.`);
  if (callers) bullets.push(`Used by ${callers} caller${callers === 1 ? '' : 's'}.`);
  if (callees) bullets.push(`Calls ${callees} other symbol${callees === 1 ? '' : 's'}.`);
  if (writes.length) bullets.push(`Writes ${writes.map(e => store.getNode(e.to)?.name ?? e.to).join(', ')}.`);
  if (reads.length) bullets.push(`Reads ${reads.map(e => store.getNode(e.to)?.name ?? e.to).join(', ')}.`);
  if (apis.length) bullets.push(`Exposed as ${apis.map(e => store.getNode(e.to)?.name ?? e.to).join(', ')}.`);
  if (tests.length) bullets.push(`Covered by ${tests.length} test${tests.length === 1 ? '' : 's'}.`);
  else if (node.kind === 'Function' || node.kind === 'Method') bullets.push('No tests currently cover this symbol.');

  const summary = bullets[0] ?? `${node.name} is in the architecture graph.`;

  return {
    title: node.name,
    summary,
    bullets: bullets.slice(1),
    paths: [],
    risks: tests.length === 0 && (node.kind === 'Function' || node.kind === 'Method')
      ? ['Untested']
      : [],
    tests: tests.map(e => store.getNode(e.from)?.name ?? e.from),
    nextSteps: [
      `archmap impact ${node.name}`,
      `archmap neighbors ${node.id}`,
    ],
  };
}

export function formatPath(store: GraphStore, path: WhyPath): string {
  if (path.steps.length === 0) return '';
  const bits: string[] = [];
  for (const step of path.steps) {
    const from = store.getNode(step.from)?.name ?? short(step.from);
    const to = store.getNode(step.to)?.name ?? short(step.to);
    const verb = VERB[step.edgeType] ?? step.edgeType.toLowerCase();
    const where = step.evidence ? ` (${step.evidence.file}:${step.evidence.line})` : '';
    bits.push(`${from} ${verb} ${to}${where}`);
  }
  return bits.join(' → ');
}

function short(id: string): string {
  const parts = id.split(':');
  return parts[parts.length - 1] || id;
}
