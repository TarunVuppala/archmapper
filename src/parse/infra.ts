// Infrastructure file ingestion.
// Parses Terraform, Docker Compose, Helm charts, and Kubernetes manifests
// into Infra nodes and DEPENDS_ON edges.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { GraphNode, GraphEdge } from '../core/types.js';
import { infraId, externalId, edgeId, fileId } from '../core/ids.js';

/**
 * Parse Docker Compose files into Infra nodes.
 */
function parseDockerCompose(
  repoPath: string,
  relPath: string,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const abs = join(repoPath, relPath);

  if (!existsSync(abs)) return { nodes, edges };

  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { return { nodes, edges }; }

  let spec: any;
  try {
    spec = JSON.parse(content);
  } catch {
    // Not JSON — try YAML via js-yaml if available
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require('js-yaml');
      spec = yaml.load(content);
    } catch {
      return { nodes, edges };
    }
  }
  if (!spec?.services) return { nodes, edges };

  const composeId = infraId(relPath);
  nodes.push({
    id: composeId,
    kind: 'Infra',
    name: basename(relPath),
    path: relPath,
    updated_at: now,
    metadata: { type: 'docker-compose' },
  });

  for (const [serviceName, serviceConfig] of Object.entries(spec.services)) {
    const config = serviceConfig as any;
    const svcId = `svc:${serviceName}`;

    nodes.push({
      id: svcId,
      kind: 'Service',
      name: serviceName,
      path: relPath,
      updated_at: now,
      metadata: {
        image: config.image,
        ports: config.ports,
        environment: config.environment ? Object.keys(config.environment) : [],
        volumes: config.volumes,
        depends_on: config.depends_on,
      },
    });

    // Link compose file to service
    edges.push({
      id: edgeId(composeId, svcId, 'CONTAINS'),
      type: 'CONTAINS',
      from: composeId,
      to: svcId,
      evidence: [{ file: relPath, line: 1, snippet: `service: ${serviceName}` }],
      sources: ['infra'],
      confidence: 1.0,
      conflict: false,
      updated_at: now,
    });

    // Link dependencies
    if (config.depends_on) {
      const deps = Array.isArray(config.depends_on) ? config.depends_on : Object.keys(config.depends_on);
      for (const dep of deps) {
        const depId = `svc:${dep}`;
        edges.push({
          id: edgeId(svcId, depId, 'DEPENDS_ON'),
          type: 'DEPENDS_ON',
          from: svcId,
          to: depId,
          evidence: [{ file: relPath, line: 1, snippet: `depends_on: ${dep}` }],
          sources: ['infra'],
          confidence: 1.0,
          conflict: false,
          updated_at: now,
        });
      }
    }

    // Link external images
    if (config.image) {
      const extId = externalId(config.image);
      nodes.push({
        id: extId,
        kind: 'External',
        name: config.image,
        updated_at: now,
      });
      edges.push({
        id: edgeId(svcId, extId, 'DEPENDS_ON'),
        type: 'DEPENDS_ON',
        from: svcId,
        to: extId,
        evidence: [{ file: relPath, line: 1, snippet: `image: ${config.image}` }],
        sources: ['infra'],
        confidence: 1.0,
        conflict: false,
        updated_at: now,
      });
    }
  }

  // Parse databases
  if (spec.volumes) {
    for (const [volName, volConfig] of Object.entries(spec.volumes)) {
      const config = volConfig as any;
      if (config?.driver === 'local' || typeof config === 'string') {
        // Could be a database volume
      }
    }
  }

  return { nodes, edges };
}

/**
 * Parse Terraform files into Infra nodes.
 */
function parseTerraform(
  repoPath: string,
  relPath: string,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const abs = join(repoPath, relPath);

  if (!existsSync(abs)) return { nodes, edges };

  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { return { nodes, edges }; }

  const tfId = infraId(relPath);
  nodes.push({
    id: tfId,
    kind: 'Infra',
    name: basename(relPath, extname(relPath)),
    path: relPath,
    updated_at: now,
    metadata: { type: 'terraform' },
  });

  // Extract resource blocks
  const resourceRegex = /^resource\s+"(\w+)"\s+"(\w+)"\s*\{/gm;
  let match;
  while ((match = resourceRegex.exec(content)) !== null) {
    const resourceType = match[1];
    const resourceName = match[2];
    const resId = `infra:${relPath}:${resourceType}.${resourceName}`;

    nodes.push({
      id: resId,
      kind: 'Infra',
      name: `${resourceType}.${resourceName}`,
      path: relPath,
      updated_at: now,
      metadata: { type: 'terraform_resource', resourceType, resourceName },
    });

    edges.push({
      id: edgeId(tfId, resId, 'CONTAINS'),
      type: 'CONTAINS',
      from: tfId,
      to: resId,
      evidence: [{ file: relPath, line: 1, snippet: `resource "${resourceType}" "${resourceName}"` }],
      sources: ['infra'],
      confidence: 1.0,
      conflict: false,
      updated_at: now,
    });

    // Extract provider references
    const providerRegex = /provider\s*=\s*"?(\w+)"?/g;
    let provMatch;
    while ((provMatch = providerRegex.exec(content)) !== null) {
      const provId = externalId(provMatch[1]);
      edges.push({
        id: edgeId(resId, provId, 'DEPENDS_ON'),
        type: 'DEPENDS_ON',
        from: resId,
        to: provId,
        evidence: [{ file: relPath, line: 1, snippet: `provider = ${provMatch[1]}` }],
        sources: ['infra'],
        confidence: 0.9,
        conflict: false,
        updated_at: now,
      });
    }
  }

  // Extract data sources
  const dataRegex = /^data\s+"(\w+)"\s+"(\w+)"\s*\{/gm;
  while ((match = dataRegex.exec(content)) !== null) {
    const resId = `infra:${relPath}:data.${match[1]}.${match[2]}`;
    nodes.push({
      id: resId,
      kind: 'Infra',
      name: `data.${match[1]}.${match[2]}`,
      path: relPath,
      updated_at: now,
      metadata: { type: 'terraform_data' },
    });
  }

  return { nodes, edges };
}

/**
 * Parse Kubernetes manifests into Infra nodes.
 */
function parseKubernetes(
  repoPath: string,
  relPath: string,
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const abs = join(repoPath, relPath);

  if (!existsSync(abs)) return { nodes, edges };

  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { return { nodes, edges }; }

  let spec: any;
  try {
    spec = JSON.parse(content);
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require('js-yaml');
      spec = yaml.load(content);
    } catch {
      return { nodes, edges };
    }
  }
  if (!spec?.kind) return { nodes, edges };

  const k8sId = infraId(relPath);
  nodes.push({
    id: k8sId,
    kind: 'Infra',
    name: `${spec.kind}/${spec.metadata?.name || basename(relPath)}`,
    path: relPath,
    updated_at: now,
    metadata: {
      type: 'kubernetes',
      kind: spec.kind,
      name: spec.metadata?.name,
      namespace: spec.metadata?.namespace,
    },
  });

  // Extract container images
  const containers = spec.spec?.containers || spec.spec?.template?.spec?.containers || [];
  for (const container of containers) {
    if (container.image) {
      const extId = externalId(container.image);
      nodes.push({
        id: extId,
        kind: 'External',
        name: container.image,
        updated_at: now,
      });
      edges.push({
        id: edgeId(k8sId, extId, 'DEPENDS_ON'),
        type: 'DEPENDS_ON',
        from: k8sId,
        to: extId,
        evidence: [{ file: relPath, line: 1, snippet: `image: ${container.image}` }],
        sources: ['infra'],
        confidence: 1.0,
        conflict: false,
        updated_at: now,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Find and parse all infrastructure files in a repo.
 */
export function parseAllInfra(
  repoPath: string,
  relativeFiles: string[],
  now: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const file of relativeFiles) {
    const ext = extname(file).toLowerCase();
    const lower = file.toLowerCase();
    const base = basename(file).toLowerCase();

    // Docker Compose
    if (base === 'docker-compose.yml' || base === 'docker-compose.yaml' || base === 'compose.yml' || base === 'compose.yaml') {
      const result = parseDockerCompose(repoPath, file, now);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }

    // Terraform
    if (ext === '.tf' || ext === '.tfvars') {
      const result = parseTerraform(repoPath, file, now);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }

    // Kubernetes / Helm
    if (
      (ext === '.yaml' || ext === '.yml') &&
      (lower.includes('k8s/') || lower.includes('kubernetes/') || lower.includes('helm/') || lower.includes('deploy/'))
    ) {
      const result = parseKubernetes(repoPath, file, now);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
    }

    // Helm Chart.yaml
    if (base === 'chart.yaml' && lower.includes('helm')) {
      const abs = join(repoPath, file);
      try {
        const content = readFileSync(abs, 'utf-8');
        let chart: any;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const yaml = require('js-yaml');
          chart = yaml.load(content);
        } catch {
          chart = JSON.parse(content);
        }
        if (chart?.name) {
          nodes.push({
            id: infraId(file),
            kind: 'Infra',
            name: `helm:${chart.name}`,
            path: file,
            updated_at: now,
            metadata: { type: 'helm_chart', version: chart.version },
          });
        }
      } catch { /* skip */ }
    }
  }

  return { nodes, edges };
}
