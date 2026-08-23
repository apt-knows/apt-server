import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { productCandidateSchema } from './domain.js';

const internalUrl = z.url().parse(process.env.APT_INTERNAL_URL).replace(/\/$/, '');
const bridgeToken = z.string().min(32).parse(process.env.APT_BRIDGE_TOKEN);

const server = new McpServer({ name: 'apt-claw-bridge', version: '1.0.0' });

function registerTool(name: string, description: string, inputSchema: Record<string, z.ZodType>, annotations?: { readOnlyHint?: boolean }) {
  server.registerTool(name, { description, inputSchema, ...(annotations ? { annotations } : {}) }, async (input) => {
    const response = await fetch(`${internalUrl}/internal/claw/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, arguments: input }),
      signal: AbortSignal.timeout(125_000),
    });
    const body = await response.json() as unknown;
    if (!response.ok) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
  });
}

registerTool('apt_search_knowledge', 'Search only the current user’s active private knowledge. User identity is server-bound.', {
  query: z.string().min(1).max(1_000), limit: z.number().int().min(1).max(20).default(10),
}, { readOnlyHint: true });
registerTool('apt_remember', 'Store a durable fact for only the current user. Never put shared policy here.', {
  subject_kind: z.enum(['self', 'recipient', 'relationship', 'other']),
  subject_label: z.string().min(1).max(160).nullable(),
  category: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  fact: z.string().min(1).max(4_000), confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['low', 'sensitive']).default('low'),
});
registerTool('apt_update_private_artifact', 'Update the current user’s private Soul, USER hot cache, or MEMORY hot cache with optimistic revision control.', {
  kind: z.enum(['soul', 'user_profile', 'memory']), content: z.string().max(20_000),
  expected_revision: z.string().regex(/^\d+$/),
});
registerTool('apt_propose_shared_change', 'Submit a sanitized shared change for founder review. This never edits or publishes a release.', {
  kind: z.enum(['core', 'soul_template', 'skill', 'policy', 'merchant', 'intent', 'tool', 'mcp']),
  title: z.string().min(1).max(200), rationale: z.string().min(1).max(4_000),
  sanitized_diff: z.string().min(1).max(50_000),
});
registerTool('apt_previous_hunts', 'Search only the current user’s previous commerce Hunts. Time-sensitive facts must be reverified.', {
  query: z.string().min(1).max(1_000), limit: z.number().int().min(1).max(10).default(5),
}, { readOnlyHint: true });
registerTool('apt_commerce_hunt', 'After using browser tools for a retail, grocery, or food Hunt, validate and save only the current source-backed candidates actually observed. This tool does not search the web and cannot purchase, cart, order, or track.', {
  vertical: z.enum(['retail', 'grocery', 'food']), goal: z.string().min(1).max(1_000),
  constraints: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)])).default({}),
  location_required: z.boolean().default(false), result_limit: z.number().int().min(1).max(5).default(5),
  query_hints: z.array(z.string().min(1).max(200)).max(5).default([]),
  candidates: z.array(productCandidateSchema).max(5),
});

await server.connect(new StdioServerTransport());
