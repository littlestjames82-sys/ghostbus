/**
 * GhostBus on Netlify — serverless hosted relay (multi-workspace).
 * Thin wrapper: supplies Netlify Blobs (strong consistency) as the KV and the
 * admin key from env. All logic lives in lib.mjs and is unit-tested with an
 * in-memory KV (deploy/netlify/test-lib.mjs).
 *
 * Setup (see docs/hosted.md): create a Netlify site from this repo, set
 * GHOSTBUS_ADMIN_KEY in site env, deploy. Blobs needs no further config.
 */
import { getStore } from '@netlify/blobs';
import { createHostedCore } from './lib.mjs';

const store = getStore({ name: 'ghostbus', consistency: 'strong' });
const kv = {
  get: (k) => store.get(k),
  set: (k, v) => store.set(k, v),
  delete: (k) => store.delete(k),
};
const handle = createHostedCore({
  kv,
  adminKey: process.env.GHOSTBUS_ADMIN_KEY || '',
  requireTokens: process.env.GHOSTBUS_REQUIRE_TOKENS === '1',
});

export default async (req) => handle(req);
export const config = { path: '/*' };
