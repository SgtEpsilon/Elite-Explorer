/**
 * historyWorker.js
 * Standalone worker thread — completely independent from journalWorker.js.
 * Reads every journal file it is given and collects all FSDJump entries.
 * Posts progress updates as it goes, then posts the full jump list when done.
 */

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const { files } = workerData;
const PROGRESS_INTERVAL = 250; // lines between progress posts

async function run() {
  const totalFiles = files.length;
  const jumps      = [];

  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
    const filePath = files[fileIndex];
    const fileName = path.basename(filePath);

    let content;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      parentPort.postMessage({ type: 'error', file: fileName, message: err.message });
      continue;
    }

    const lines      = content.split('\n');
    const totalLines = lines.length;

    for (let i = 0; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);

        if (entry.event === 'FSDJump') {
          jumps.push({
            system:       entry.StarSystem   || null,
            timestamp:    entry.timestamp    || null,
            jumpDist:     entry.JumpDist     != null ? +entry.JumpDist.toFixed(2) : null,
            pos:          entry.StarPos      ? entry.StarPos.map(n => +n.toFixed(2)) : null,
            wasDiscovered: entry.SystemAlreadyDiscovered !== false,
            starClass:    entry.StarClass    || null,
            bodyCount:    entry.Body_count   != null ? entry.Body_count : null,
          });
        }
      } catch {
        // skip malformed lines
      }

      if (i % PROGRESS_INTERVAL === 0 || i === totalLines - 1) {
        parentPort.postMessage({
          type: 'progress',
          file: fileName,
          currentLine: i + 1,
          totalLines,
          fileIndex: fileIndex + 1,
          totalFiles,
          jumpsFound: jumps.length,
        });
      }
    }
  }

  // Send newest-first
  parentPort.postMessage({ type: 'done', jumps: jumps.slice().reverse() });
}

run().catch(err => parentPort.postMessage({ type: 'error', message: err.message }));
