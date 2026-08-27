import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import {
  commerceHuntRecordSchema,
  type CommerceHuntRecord,
} from './domain.js';

export async function validateBrowserHuntRecord(rawInput: unknown, now = Date.now()): Promise<CommerceHuntRecord> {
  const input = commerceHuntRecordSchema.parse(rawInput);
  const productUrls = new Set<string>();
  for (const candidate of input.candidates) {
    const observedAt = Date.parse(candidate.observed_at);
    if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > 24 * 60 * 60_000) {
      throw new Error('Browser-researched candidates must have been observed within the last 24 hours.');
    }
    if (candidate.candidate_kind === 'product') {
      const canonicalUrl = directProductUrl(candidate.canonical_url);
      directProductUrl(candidate.source_url);
      const key = canonicalUrl.href.replace(/#.*$/, '');
      if (productUrls.has(key)) throw new Error('Each product candidate must have a distinct direct-product URL.');
      productUrls.add(key);
    }
  }
  await Promise.all(input.candidates.flatMap((candidate) => [
    assertPublicHttpUrl(candidate.canonical_url),
    assertPublicHttpUrl(candidate.source_url),
    ...(candidate.image_url ? [assertPublicHttpUrl(candidate.image_url)] : []),
  ]));
  return input;
}

function directProductUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if ((!url.pathname || url.pathname === '/') && !url.search) {
    throw new Error('Product candidates require a direct-product URL, not a merchant homepage.');
  }
  return url;
}

export async function assertPublicHttpUrl(rawUrl: string) {
  return (await resolvePublicHttpUrl(rawUrl)).url;
}

async function resolvePublicHttpUrl(rawUrl: string): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free public HTTP(S) URLs are allowed.');
  }
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
