import { z } from 'zod';
import { trustedItemSnapshotSchema } from '../shopping/domain.js';

export const CLAW_ALLOWED_CAPABILITIES = ['memory', 'session_search', 'skills', 'browser', 'apt_bridge'] as const;
export const CLAW_HISTORY_BUDGET_DEFAULT = 48_000;
export const CLAW_LOCATION_MAX_AGE_MS = 5 * 60 * 1_000;
export const CLAW_LOCATION_MAX_ACCURACY_METERS = 1_000;
const directCommerceTransaction = /\b(?:place|submit|complete|finali[sz]e)\s+(?:the\s+|my\s+|an?\s+)?(?:restaurant\s+)?order\b|\b(?:add\s+(?:it|this|them|the\s+\w+)\s+to\s+(?:my\s+|the\s+)?cart|check\s*out|checkout|buy|purchase|order)\s+(?:it|this|them|that|for me|now)\b|\b(?:reserve|book)\s+(?:it|this|a\s+table|the\s+restaurant)\b|\b(?:contact|call|message|email)\s+(?:the\s+)?(?:merchant|restaurant|store)\b|\b(?:track|cancel|return)\s+(?:the\s+|my\s+|an?\s+)?order\b/i;
const aptOwnedDestination = /\b(?:my\s+)?apt(?:'s)?\s+(?:cart|wishlist|board)\b|\b(?:cart|wishlist|board)\s+(?:in|on)\s+apt\b/i;

export const foregroundLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive().max(CLAW_LOCATION_MAX_ACCURACY_METERS),
  capturedAt: z.iso.datetime({ offset: true }),
  coarseLabel: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/),
}).strict();

export type ForegroundLocation = z.infer<typeof foregroundLocationSchema>;

export function validateForegroundLocation(location: ForegroundLocation, now = Date.now()) {
  const capturedAt = Date.parse(location.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt > now + 30_000 || now - capturedAt > CLAW_LOCATION_MAX_AGE_MS) {
    throw new Error('Foreground location is stale or has an invalid capture time.');
  }
  return location;
}

export function shouldWithholdForegroundLocation(message: string) {
  return directCommerceTransaction.test(message) && !aptOwnedDestination.test(message);
}

export const productCandidateSchema = trustedItemSnapshotSchema.safeExtend({
  candidate_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});

export type ProductCandidate = z.infer<typeof productCandidateSchema>;

export const commerceHuntInputSchema = z.object({
  vertical: z.enum(['retail', 'grocery', 'food']),
  goal: z.string().trim().min(1).max(1_000),
  constraints: z.record(z.string().max(64), z.union([
    z.string().max(500), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(20),
  ])).default({}),
  location_required: z.boolean().default(false),
  result_limit: z.number().int().min(1).max(5).default(5),
  query_hints: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
}).strict();

export type CommerceHuntInput = z.infer<typeof commerceHuntInputSchema>;

export const commerceHuntRecordSchema = commerceHuntInputSchema.extend({
  candidates: z.array(productCandidateSchema).max(5),
}).superRefine((value, context) => {
  if (value.candidates.length > value.result_limit) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'Candidate count exceeds result_limit.' });
  }
  const ids = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    if (candidate.vertical !== value.vertical) {
      context.addIssue({ code: 'custom', path: ['candidates', index, 'vertical'], message: 'Candidate vertical does not match the Hunt.' });
    }
    if (ids.has(candidate.candidate_id)) {
      context.addIssue({ code: 'custom', path: ['candidates', index, 'candidate_id'], message: 'Candidate IDs must be unique.' });
    }
    ids.add(candidate.candidate_id);
  });
});

export type CommerceHuntRecord = z.infer<typeof commerceHuntRecordSchema>;

export interface ClawDocument {
  key: string;
  kind: 'core' | 'soul_template' | 'policy' | 'intent' | 'merchant' | 'skill';
  title: string;
  content: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  checksum: string;
}

export interface ClawCapability {
  key: string;
  kind: 'toolset' | 'mcp';
  enabled: boolean;
  config: Record<string, unknown>;
  instructions: string;
  secretRefs: string[];
  checksum: string;
}

export interface ClawPrivateProfile {
  soulText: string;
  hotUserText: string;
  hotMemoryText: string;
  revision: string;
  knowledgeRevision: string;
  runtimeHash: string | null;
}

export interface ClawKnowledgeFact {
  id: string;
  subjectKind: 'self' | 'recipient' | 'relationship' | 'other';
  subjectLabel: string | null;
  category: string;
  fact: string;
  confidence: number;
  learnedAt: string;
}

export interface ClawPrivateSkill {
  key: string;
  title: string;
  content: string;
  checksum: string;
}

export interface ClawPublishedRelease {
  id: string;
  version: number;
  checksum: string;
  documents: ClawDocument[];
  capabilities: ClawCapability[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PreviousHunt {
  id: string;
  category: 'retail' | 'grocery' | 'food';
  candidates: ProductCandidate[];
  createdAt: string;
}

export interface ClawTurnBundle {
  release: ClawPublishedRelease;
  profile: ClawPrivateProfile;
  knowledge: ClawKnowledgeFact[];
  privateSkills: ClawPrivateSkill[];
  previousHunts: PreviousHunt[];
  conversationHistory: ConversationMessage[];
}
