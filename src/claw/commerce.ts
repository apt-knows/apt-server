import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import {
  commerceHuntRecordSchema,
  type CommerceHuntRecord,
  type ProductCandidate,
} from './domain.js';

export interface BrowserHuntEvidenceRequirements {
  locationRequired?: boolean;
  coarseLocationLabel?: string | null;
}

export async function validateBrowserHuntRecord(
  rawInput: unknown,
  now = Date.now(),
  requirements: BrowserHuntEvidenceRequirements = {},
): Promise<CommerceHuntRecord> {
  const input = commerceHuntRecordSchema.parse(rawInput);
  const locationRequired = requirements.locationRequired ?? input.location_required;
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
    if (locationRequired) {
      assertLocationEvidence(candidate, requirements.coarseLocationLabel ?? null, input.constraints.fulfillment);
    }
  }
  await Promise.all(input.candidates.flatMap((candidate) => [
    assertPublicHttpUrl(candidate.canonical_url),
    assertPublicHttpUrl(candidate.source_url),
    ...(candidate.image_url ? [assertPublicHttpUrl(candidate.image_url)] : []),
  ]));
  return input;
}

function assertLocationEvidence(
  candidate: ProductCandidate,
  coarseLocationLabel: string | null,
  requestedFulfillment: string | number | boolean | string[] | undefined,
) {
  const context = candidate.fulfillment_or_store_context;
  if (!context || candidate.verification_status === 'unconfirmed') {
    throw new Error('Location-scoped candidates require verified fulfillment or store context.');
  }
  if (coarseLocationLabel) {
    const normalizedContext = normalizeEvidence(context);
    const anchors = coarseLocationAnchors(coarseLocationLabel);
    const matchedAnchor = anchors.find((anchor) => normalizedContext.includes(anchor));
    if (!matchedAnchor || negatesLocationAnchor(normalizedContext, matchedAnchor)) {
      throw new Error('Candidate fulfillment or store context does not verify the coarse search area.');
    }
  }
  if (typeof requestedFulfillment === 'string') {
    const fulfillment = normalizeEvidence(requestedFulfillment);
    const contextValue = normalizeEvidence(context);
    const fulfillmentTerms = fulfillment === 'pickup'
      ? ['pickup', 'pick up', 'collection']
      : fulfillment === 'delivery'
        ? ['delivery', 'deliver', 'shipping', 'ship to']
        : [fulfillment];
    const matchedTerm = fulfillmentTerms.find((term) => contextValue.includes(term));
    if (!matchedTerm || negatesFulfillmentTerm(contextValue, matchedTerm)) {
      throw new Error('Candidate context does not verify the requested fulfillment method.');
    }
  }
}

function coarseLocationAnchors(label: string) {
  const parts = label.split(',').map(normalizeEvidence).filter(Boolean);
  const postalCodes = parts.filter((part) => /\d/.test(part));
  const locality = parts[0] && parts[0].length > 2 ? [parts[0]] : [];
  return [...new Set([...postalCodes, ...locality])];
}

function normalizeEvidence(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function negatesLocationAnchor(context: string, anchor: string) {
  const index = context.indexOf(anchor);
  if (index < 0) return false;
  const nearby = context.slice(Math.max(0, index - 40), Math.min(context.length, index + anchor.length + 40));
  return /\b(?:not|outside|away from|unconfirmed|unverified|unknown|different|does not serve|not shown|not near)\b/u.test(nearby);
}

function negatesFulfillmentTerm(context: string, term: string) {
  return [
    `no ${term}`,
    `without ${term}`,
    `${term} unavailable`,
    `${term} not available`,
    `${term} unconfirmed`,
    `${term} unknown`,
    `not available for ${term}`,
  ].some((phrase) => context.includes(phrase));
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
