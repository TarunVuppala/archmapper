// OpenAPI / Swagger / AsyncAPI / Proto ingestion.
// Parses API specifications into graph nodes and edges.

import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { GraphNode, GraphEdge, Evidence } from '../core/types.js';
import { apiId, fileId, edgeId, tableId } from '../core/ids.js';

interface OpenAPIPath {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
  requestBody?: { content?: Record<string, any> };
  responses?: Record<string, any>;
  parameters?: Array<{ name: string; in: string; schema?: any }>;
}

/**
 * Parse an OpenAPI/Swagger YAML or JSON file into graph nodes and edges.
 * Supports both OpenAPI 3.x and Swagger 2.0 formats.
 */
export function parseOpenAPI(
  repoPath: string,
  relPath: string,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const abs = join(repoPath, relPath);

  if (!existsSync(abs)) return { nodes, edges };

  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return { nodes, edges };
  }

  const ext = extname(relPath).toLowerCase();
  let spec: any;

  try {
    if (ext === '.json') {
      spec = JSON.parse(content);
    } else if (ext === '.yaml' || ext === '.yml') {
      try {
        const yaml = require('js-yaml');
        spec = yaml.load(content);
      } catch {
        spec = JSON.parse(content);
      }
    } else {
      return { nodes, edges };
    }
  } catch {
    return { nodes, edges };
  }

  if (!spec || !spec.paths) return { nodes, edges };

  // Create a Contract node for the spec file
  const contractId = `contract:${relPath}`;
  nodes.push({
    id: contractId,
    kind: 'Contract',
    name: spec.info?.title || relPath,
    path: relPath,
    updated_at: now,
    metadata: {
      version: spec.info?.version,
      description: spec.info?.description,
      format: spec.openapi ? 'openapi' : 'swagger',
    },
  });

  // Create Doc node for the spec
  const docId = `doc:${relPath}`;
  nodes.push({
    id: docId,
    kind: 'Doc',
    name: spec.info?.title || relPath,
    path: relPath,
    updated_at: now,
  });

  // Parse paths
  const paths = spec.paths as Record<string, Record<string, any>>;
  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== 'object' || !operation) continue;
      if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method.toLowerCase())) {
        const upperMethod = method.toUpperCase();
        const apiNodeId = apiId(upperMethod, pathStr);

        nodes.push({
          id: apiNodeId,
          kind: 'API',
          name: `${upperMethod} ${pathStr}`,
          path: relPath,
          updated_at: now,
          signature: operation.summary || `${upperMethod} ${pathStr}`,
          metadata: {
            operationId: operation.operationId,
            tags: operation.tags,
            parameters: operation.parameters?.map((p: any) => ({
              name: p.name,
              in: p.in,
              required: p.required,
              type: p.schema?.type || p.type,
            })),
            responses: operation.responses ? Object.keys(operation.responses) : [],
            requestBody: operation.requestBody ? Object.keys(operation.requestBody.content || {}) : [],
          },
        });

        // Link contract to API
        edges.push({
          id: edgeId(contractId, apiNodeId, 'DOCUMENTS'),
          type: 'DOCUMENTS',
          from: contractId,
          to: apiNodeId,
          evidence: [{ file: relPath, line: 1, snippet: `${upperMethod} ${pathStr}` }],
          sources: ['openapi'],
          confidence: 1.0,
          conflict: false,
          updated_at: now,
        });

        // Parse request body for table references
        if (operation.requestBody?.content) {
          for (const [contentType, body] of Object.entries(operation.requestBody.content)) {
            const schema = (body as any)?.schema;
            if (schema?.properties) {
              // Map property names to potential table references
              for (const [propName, propSchema] of Object.entries(schema.properties)) {
                const tId = tableId(propName);
                // Only create if we find a matching table pattern
                if (propName.endsWith('_id') || propName === 'id') {
                  const refTable = propName.replace('_id', '');
                  const refTableId = tableId(refTable);
                  edges.push({
                    id: edgeId(apiNodeId, refTableId, 'CONSUMES'),
                    type: 'CONSUMES',
                    from: apiNodeId,
                    to: refTableId,
                    evidence: [{ file: relPath, line: 1, snippet: `requestBody.${propName}` }],
                    sources: ['openapi'],
                    confidence: 0.7,
                    conflict: false,
                    updated_at: now,
                  });
                }
              }
            }
          }
        }

        // Parse responses for table references
        if (operation.responses) {
          for (const [statusCode, response] of Object.entries(operation.responses)) {
            const resp = response as any;
            if (resp?.content) {
              for (const [contentType, content] of Object.entries(resp.content)) {
                const schema = (content as any)?.schema;
                if (schema?.properties) {
                  for (const propName of Object.keys(schema.properties)) {
                    if (propName.endsWith('_id') || propName === 'id') {
                      const refTable = propName.replace('_id', '');
                      const refTableId = tableId(refTable);
                      edges.push({
                        id: edgeId(apiNodeId, refTableId, 'READS'),
                        type: 'READS',
                        from: apiNodeId,
                        to: refTableId,
                        evidence: [{ file: relPath, line: 1, snippet: `response.${statusCode}.${propName}` }],
                        sources: ['openapi'],
                        confidence: 0.6,
                        conflict: false,
                        updated_at: now,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Parse Protocol Buffer (.proto) files into graph nodes and edges.
 */
export function parseProto(
  repoPath: string,
  relPath: string,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const abs = join(repoPath, relPath);

  if (!existsSync(abs)) return { nodes, edges };

  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return { nodes, edges };
  }

  const lines = content.split('\n');

  // Extract package name
  const pkgMatch = content.match(/^package\s+([\w.]+);/m);
  const packageName = pkgMatch?.[1] || relPath;

  // Extract services and their RPC methods
  const serviceRegex = /^service\s+(\w+)\s*\{/gm;
  let match;
  while ((match = serviceRegex.exec(content)) !== null) {
    const serviceName = match[1];
    const svcId = `svc:${packageName}.${serviceName}`;

    nodes.push({
      id: svcId,
      kind: 'Service',
      name: serviceName,
      path: relPath,
      updated_at: now,
      metadata: { package: packageName, type: 'protobuf' },
    });

    // Find the service block and extract RPC methods
    const serviceStart = match.index + match[0].length;
    let depth = 1;
    let i = content.indexOf('\n', match.index);
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    const serviceBody = content.slice(serviceStart, i - 1);

    const rpcRegex = /^s*rpc\s+(\w+)\s*\((\w+)\)\s*returns\s*\((\w+)\)/gm;
    let rpcMatch;
    while ((rpcMatch = rpcRegex.exec(serviceBody)) !== null) {
      const rpcName = rpcMatch[1];
      const inputType = rpcMatch[2];
      const outputType = rpcMatch[3];

      const rpcId = `fn:${relPath}:${rpcName}`;
      nodes.push({
        id: rpcId,
        kind: 'Method',
        name: rpcName,
        path: relPath,
        updated_at: now,
        signature: `rpc ${rpcName}(${inputType}) returns (${outputType})`,
      });

      edges.push({
        id: edgeId(svcId, rpcId, 'CONTAINS'),
        type: 'CONTAINS',
        from: svcId,
        to: rpcId,
        evidence: [{ file: relPath, line: 1, snippet: `rpc ${rpcName}` }],
        sources: ['parser'],
        confidence: 1.0,
        conflict: false,
        updated_at: now,
      });
    }
  }

  // Extract message types → Table-like nodes
  const messageRegex = /^message\s+(\w+)\s*\{/gm;
  while ((match = messageRegex.exec(content)) !== null) {
    const msgName = match[1];
    const msgId = `table:${msgName}`;

    // Only create if it looks like a data entity (has fields)
    const msgStart = match.index + match[0].length;
    let depth = 1;
    let i = content.indexOf('\n', match.index);
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    const msgBody = content.slice(msgStart, i - 1);
    const fieldCount = (msgBody.match(/^\s+\w+\s+/gm) || []).length;

    if (fieldCount >= 2) {
      nodes.push({
        id: msgId,
        kind: 'Table',
        name: msgName,
        path: relPath,
        updated_at: now,
        metadata: { type: 'protobuf_message', fields: fieldCount },
      });
    }
  }

  return { nodes, edges };
}

/**
 * Find and parse all API spec files in a repo.
 */
export function parseAllAPISpecs(
  repoPath: string,
  relativeFiles: string[],
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const file of relativeFiles) {
    const ext = extname(file).toLowerCase();
    const lower = file.toLowerCase();

    // OpenAPI / Swagger
    if (
      (ext === '.yaml' || ext === '.yml' || ext === '.json') &&
      (lower.includes('openapi') || lower.includes('swagger') || lower.includes('api-spec'))
    ) {
      const result = parseOpenAPI(repoPath, file, now);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }

    // AsyncAPI
    if (
      (ext === '.yaml' || ext === '.yml' || ext === '.json') &&
      lower.includes('asyncapi')
    ) {
      const result = parseOpenAPI(repoPath, file, now); // Same parser works for AsyncAPI paths
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }

    // Protocol Buffers
    if (ext === '.proto') {
      const result = parseProto(repoPath, file, now);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }
  }

  return { nodes, edges };
}
