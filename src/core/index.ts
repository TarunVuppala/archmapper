// Architecture Mapper Core — the ONE source of truth.
// Public API for all core operations.

export { GraphStore } from './store.js';
export { computeImpact, type ImpactOptions } from './impact.js';
export { computeDiffImpact, diffSymbols, type DiffOptions } from './diff.js';
export { evaluatePolicies, type Policy } from './policy.js';
export { RAGIndex, type RAGChunk } from './rag.js';
export { Journal, type JournalEntry } from './journal.js';
export { healthCheck } from './health.js';
export { reconstructFlow, flowFromAPI, flowFromFunction } from './flow.js';
export * from './ids.js';
export * from './types.js';

// Re-export server entry points
export { startMCPServer } from '../mcp/server.js';
export { startDaemon } from '../daemon/server.js';
export { startUIServer } from '../ui/server.js';
