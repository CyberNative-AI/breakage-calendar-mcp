// Runs a scan in a worker thread that is stopped at a deadline or when its heap limit is reached.
import { Worker } from 'node:worker_threads';
import { LIMITS } from './walk.mjs';

export const DEADLINE_MS = 120 * 1000;
export const HEAP_MB = 256;

export function runScan(job, { deadlineMs = DEADLINE_MS, heapMb = HEAP_MB } = {}) {
  return new Promise((done) => {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { limits: LIMITS, ...job },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); w.terminate(); done(r); };
    const timer = setTimeout(() => finish({ error: `the search did not finish within ${Math.round(deadlineMs / 1000)} s` }), deadlineMs);
    w.once('message', (m) => finish(m));
    w.once('error', (e) => finish({ error: e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `the search reached its ${heapMb} MB memory limit` : `the search failed: ${String((e && e.message) || e).slice(0, 200)}` }));
    w.once('exit', (c) => finish({ error: `the search thread stopped (exit ${c})` }));
  });
}
