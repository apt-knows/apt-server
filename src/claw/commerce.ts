import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import {
  commerceHuntInputSchema,
  productCandidateSchema,
  type CommerceHuntInput,
  type ForegroundLocation,
  type ProductCandidate,
} from './domain.js';

export const COMMERCE_MAX_DURATION_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface CommerceSearchAdapter {
  search(input: CommerceHuntInput, location: ForegroundLocation | null, signal: AbortSignal): Promise<ProductCandidate[]>;
}

export class MissingCommerceSearchAdapter implements CommerceSearchAdapter {
  async search(): Promise<ProductCandidate[]> {
    throw new Error('Commerce retrieval provider is not configured.');
  }
}

const providerResponseSchema = z.object({
  candidates: z.array(productCandidateSchema).max(5),
}).strict();

export class HttpCommerceSearchAdapter implements CommerceSearchAdapter {
  constructor(private readonly endpoint: string, private readonly apiKey: string) {}

  async search(rawInput: CommerceHuntInput, location: ForegroundLocation | null, signal: AbortSignal) {
    const input = commerceHuntInputSchema.parse(rawInput);
    const target = await resolvePublicHttpUrl(this.endpoint, true);
    const dispatcher = new Agent({
      maxResponseSize: MAX_RESPONSE_BYTES,
      connect: {
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, target.addresses);
          else callback(null, target.addresses[0]!.address, target.addresses[0]!.family);
        },
      },
    });
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        redirect: 'manual',
        dispatcher,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          vertical: input.vertical,
          goal: input.goal,
          constraints: input.constraints,
          query_hints: input.query_hints,
          result_limit: input.result_limit,
          ...(input.location_required && location ? { location } : {}),
        }),
        signal,
      });
      if (response.status >= 300 && response.status < 400) throw new Error('Commerce provider redirects are not allowed.');
      if (!response.ok) throw new Error(`Commerce provider failed with status ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('Commerce provider response is too large.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Commerce provider response is too large.');
      const parsed = providerResponseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const candidates = parsed.candidates.slice(0, input.result_limit);
      await Promise.all(candidates.flatMap((candidate) => [
        assertPublicHttpUrl(candidate.canonical_url),
        assertPublicHttpUrl(candidate.source_url),
        ...(candidate.image_url ? [assertPublicHttpUrl(candidate.image_url)] : []),
      ]));
      if (candidates.some((candidate) => candidate.vertical !== input.vertical)) {
        throw new Error('Commerce provider returned a candidate outside the requested vertical.');
      }
      return candidates;
    } finally {
      await dispatcher.close();
    }
  }
}

export async function assertPublicHttpUrl(rawUrl: string) {
  return (await resolvePublicHttpUrl(rawUrl)).url;
}

async function resolvePublicHttpUrl(rawUrl: string, requireHttps = false): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free public HTTP(S) URLs are allowed.');
  }
  if (requireHttps && url.protocol !== 'https:') throw new Error('The commerce provider endpoint must use HTTPS.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local network URLs are blocked.');
  }
  const literalFamily = isIP(hostname);
  const addresses: LookupAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private, link-local, loopback, and metadata-network URLs are blocked.');
  }
  return { url, addresses };
}

export function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0] ?? '';
  if (!ipaddr.isValid(normalized)) return false;
  const parsed = ipaddr.process(normalized);
  return parsed.range() !== 'unicast';
}
