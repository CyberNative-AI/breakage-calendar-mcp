// Scan worker: the regular expressions (which come from the calendar files) run here, so the main thread can stop
// this thread at a deadline and its heap limit bounds memory. Two modes: a folder on disk, or files given as text.
import { parentPort, workerData } from 'node:worker_threads';
import { scanTree } from './walk.mjs';
import { scan } from './match.js';

const { mode, base, files, sigs, limits } = workerData;
if (mode === 'files') parentPort.postMessage({ rows: scan(files, sigs), stats: { files: files.length } });
else parentPort.postMessage(scanTree(base, sigs, limits));
