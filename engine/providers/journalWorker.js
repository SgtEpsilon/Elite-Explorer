/**
 * journalWorker.js
 * 
 * This file runs in a separate Worker Thread — completely isolated from the
 * main process. It does all the heavy file-reading work so the UI never freezes.
 * 
 * It communicates back to the main thread by posting messages.
 */

const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { files, lastProcessed } = workerData;

// We throttle progress updates — instead of sending one per line (could be
// 50,000+ messages), we only send an update every 500 lines or at the end.
const PROGRESS_INTERVAL = 500;

async function run() {
  const totalFiles = files.length;
  const updatedLastProcessed = { ...lastProcessed };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex];
    const fileName = path.basename(filePath);

    let content;
    try {
      // Use async readFile so the thread isn't blocked either
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      parentPort.postMessage({ type: 'error', file: fileName, message: err.message });
      continue;
    }

    const lines = content.split('\n');
    let startIndex = 0;

    if (updatedLastProcessed[fileName] != null) {
      startIndex = updatedLastProcessed[fileName] + 1;
    }

    const totalLines = lines.length;

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);

        // Send parsed journal events back to main process for DB writing
        if (entry.event === 'Scan') {
          parentPort.postMessage({
            type: 'event',
            event: 'journal.scan',
            data: {
              system: entry.StarSystem,
              body: entry.BodyName,
              bodyType: entry.BodyType,
              timestamp: entry.timestamp
            }
          });
        }

        if (entry.event === 'Location') {
          parentPort.postMessage({
            type: 'event',
            event: 'journal.location',
            data: {
              system: entry.StarSystem,
              timestamp: entry.timestamp
            }
          });
        }
      } catch {
        // Skip malformed JSON lines — journals sometimes have partial writes
      }

      updatedLastProcessed[fileName] = i;

      // Only send progress update every N lines (not every single line)
      if (i % PROGRESS_INTERVAL === 0 || i === totalLines - 1) {
        parentPort.postMessage({
          type: 'progress',
          file: fileName,
          currentLine: i + 1,
          totalLines,
          fileIndex: fileIndex + 1,
          totalFiles
        });
      }
    }
  }

  // When all done, send the updated lastProcessed map back so main can save it
  parentPort.postMessage({ type: 'done', updatedLastProcessed });
}

run().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
