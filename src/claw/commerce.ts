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
  for (const candidate of input.candidates) {
    const observedAt = Date.parse(candidate.observed_at);
    if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > 24 * 60 * 60_000) {
      throw new Error('Browser-researched candidates must have been observed within the last 24 hours.');
    }
  }
  await Promise.all(input.candidates.flatMap((candidate) => [
    assertPublicHttpUrl(candidate.canonical_url),
    assertPublicHttpUrl(candidate.source_url),
    ...(candidate.image_url ? [assertPublicHttpUrl(candidate.image_url)] : []),
  ]));
  return input;
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
