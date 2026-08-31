// Circuit breaker for LLM thrashing.
// Detects when LLM-generated edges are fluctuating (thrashing) and pauses inference.
// Keeps the existing graph intact; only blocks new LLM edge proposals.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface CircuitState {
  /** Number of consecutive LLM runs that added conflicting edges */
  consecutiveConflicts: number;
  /** Timestamp of last conflict detection */
  lastConflictAt: string | null;
  /** Whether the circuit is open (LLM inference paused) */
  isOpen: boolean;
  /** When the circuit was opened */
  openedAt: string | null;
  /** Total LLM edge proposals in the current window */
  proposalsInWindow: number;
  /** Total conflicting proposals in the current window */
  conflictsInWindow: number;
  /** Window start timestamp */
  windowStart: string;
}

const CONFLICT_THRESHOLD = 5;      // Open circuit after 5 consecutive conflicts
const WINDOW_SIZE = 60_000;         // 1 minute window for counting
const COOLDOWN_MS = 5 * 60_000;    // 5 minute cooldown before retry

function getStatePath(repoPath: string): string {
  return join(repoPath, '.archmap', 'circuit-breaker.json');
}

function loadState(repoPath: string): CircuitState {
  const path = getStatePath(repoPath);
  if (!existsSync(path)) {
    return {
      consecutiveConflicts: 0,
      lastConflictAt: null,
      isOpen: false,
      openedAt: null,
      proposalsInWindow: 0,
      conflictsInWindow: 0,
      windowStart: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {
      consecutiveConflicts: 0,
      lastConflictAt: null,
      isOpen: false,
      openedAt: null,
      proposalsInWindow: 0,
      conflictsInWindow: 0,
      windowStart: new Date().toISOString(),
    };
  }
}

function saveState(repoPath: string, state: CircuitState): void {
  const dir = join(repoPath, '.archmap');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(repoPath), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Check if the circuit breaker is allowing LLM inference.
 */
export function isCircuitOpen(repoPath: string): { open: boolean; reason?: string } {
  const state = loadState(repoPath);

  if (!state.isOpen) return { open: false };

  // Check if cooldown has elapsed
  if (state.openedAt) {
    const elapsed = Date.now() - new Date(state.openedAt).getTime();
    if (elapsed > COOLDOWN_MS) {
      // Cooldown elapsed — half-open: allow one probe
      state.isOpen = false;
      state.consecutiveConflicts = 0;
      saveState(repoPath, state);
      return { open: false };
    }

    const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return {
      open: true,
      reason: `Circuit open — ${state.conflictsInWindow} conflicts in window. Retry in ${remaining}s.`,
    };
  }

  return { open: true, reason: 'Circuit open — LLM thrashing detected.' };
}

/**
 * Record an LLM proposal. Call after each LLM-generated edge is upserted.
 */
export function recordProposal(repoPath: string, isConflict: boolean): void {
  const state = loadState(repoPath);
  const now = Date.now();
  const windowStart = new Date(state.windowStart).getTime();

  // Reset window if expired
  if (now - windowStart > WINDOW_SIZE) {
    state.windowStart = new Date().toISOString();
    state.proposalsInWindow = 0;
    state.conflictsInWindow = 0;
  }

  state.proposalsInWindow++;

  if (isConflict) {
    state.conflictsInWindow++;
    state.consecutiveConflicts++;
    state.lastConflictAt = new Date().toISOString();

    if (state.consecutiveConflicts >= CONFLICT_THRESHOLD) {
      state.isOpen = true;
      state.openedAt = new Date().toISOString();
    }
  } else {
    // Reset consecutive conflicts on a non-conflicting proposal
    state.consecutiveConflicts = 0;
  }

  saveState(repoPath, state);
}

/**
 * Reset the circuit breaker manually.
 */
export function resetCircuit(repoPath: string): void {
  saveState(repoPath, {
    consecutiveConflicts: 0,
    lastConflictAt: null,
    isOpen: false,
    openedAt: null,
    proposalsInWindow: 0,
    conflictsInWindow: 0,
    windowStart: new Date().toISOString(),
  });
}

/**
 * Get circuit breaker status for display.
 */
export function circuitStatus(repoPath: string): {
  open: boolean;
  consecutiveConflicts: number;
  proposalsInWindow: number;
  conflictsInWindow: number;
  lastConflictAt: string | null;
  cooldownRemaining?: number;
} {
  const state = loadState(repoPath);
  let cooldownRemaining: number | undefined;

  if (state.isOpen && state.openedAt) {
    const elapsed = Date.now() - new Date(state.openedAt).getTime();
    cooldownRemaining = Math.max(0, Math.ceil((COOLDOWN_MS - elapsed) / 1000));
  }

  return {
    open: state.isOpen,
    consecutiveConflicts: state.consecutiveConflicts,
    proposalsInWindow: state.proposalsInWindow,
    conflictsInWindow: state.conflictsInWindow,
    lastConflictAt: state.lastConflictAt,
    cooldownRemaining,
  };
}
