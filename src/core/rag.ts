// RAG chunk index + lexical search over the one graph.
// Chunks are created from node content; search returns ranked results.

import type { GraphNode, SearchResult } from './types.js';
import type { GraphStore } from './store.js';

export interface RAGChunk {
  id: string;
  nodeId: string;
  content: string;
  tokens: string[];
}

interface RawSearchResult {
  chunkIdx: number;
  score: number;
}

// Simple in-memory RAG index (no embeddings — lexical search only for v1)
export class RAGIndex {
  private chunks: RAGChunk[] = [];
  private invertedIndex: Map<string, Set<number>> = new Map();

  indexNodes(store: GraphStore): void {
    this.chunks = [];
    this.invertedIndex.clear();

    const nodes = store.listNodes();
    for (const node of nodes) {
      const content = this.nodeToContent(node);
      const tokens = this.tokenize(content);
      const chunk: RAGChunk = {
        id: `rag:${node.id}`,
        nodeId: node.id,
        content,
        tokens,
      };
      const idx = this.chunks.length;
      this.chunks.push(chunk);

      for (const token of tokens) {
        if (!this.invertedIndex.has(token)) {
          this.invertedIndex.set(token, new Set());
        }
        this.invertedIndex.get(token)!.add(idx);
      }
    }
  }

  searchRaw(query: string, limit = 20): RawSearchResult[] {
    const queryTokens = this.tokenize(query);
    const scores = new Map<number, number>();

    for (const token of queryTokens) {
      const indices = this.invertedIndex.get(token);
      if (indices) {
        for (const idx of indices) {
          scores.set(idx, (scores.get(idx) || 0) + 1);
        }
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idx, score]) => ({
        chunkIdx: idx,
        score: score / queryTokens.length,
      }));
  }

  searchWithNodes(store: GraphStore, query: string, limit = 20): SearchResult[] {
    const raw = this.searchRaw(query, limit);
    const queryTokens = this.tokenize(query);

    return raw.map(r => {
      const chunk = this.chunks[r.chunkIdx];
      const node = store.getNode(chunk.nodeId);
      return {
        node: node ?? ({ id: chunk.nodeId, kind: 'Function' as const, name: chunk.nodeId, updated_at: '' } as GraphNode),
        score: r.score,
        snippet: chunk.content.slice(0, 200),
      };
    });
  }

  private nodeToContent(node: GraphNode): string {
    const parts = [
      node.name,
      node.kind,
      node.path ?? '',
      node.signature ?? '',
      node.id,
      ...(node.tags ?? []),
    ];
    return parts.join(' ');
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_.:/-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  get chunkCount(): number {
    return this.chunks.length;
  }
}
