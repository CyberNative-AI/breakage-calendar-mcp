// Preloaded with --import in tests that run the real binary: answers the two calendar URLs from the fixtures,
// so those tests need no network.
import { readFileSync } from 'node:fs';
const dir = new URL('./', import.meta.url);
globalThis.fetch = async (url) => new Response(readFileSync(new URL(String(url).endsWith('/entries.json') ? 'entries.json' : 'signatures.json', dir)), { headers: { 'content-type': 'application/json' } });
