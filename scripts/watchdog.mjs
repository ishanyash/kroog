// Loaded before each test file (node --import, from scripts/test.mjs). If the file is still
// running after KROOG_TEST_WATCHDOG milliseconds, it prints what keeps the process alive
// (open servers, sockets, pipes, child processes, timers) and stops it with a failure.
const ms = Number(process.env.KROOG_TEST_WATCHDOG) || 120000;
const started = Date.now();
setTimeout(() => {
  const open = process.getActiveResourcesInfo();
  const counts = {};
  for (const r of open) counts[r] = (counts[r] || 0) + 1;
  const list = Object.entries(counts).map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
  process.stderr.write(`\nwatchdog: ${process.argv[1]} still running after ${Math.round((Date.now() - started) / 1000)}s. What keeps it running: ${list || 'nothing listed'}\n`);
  process.exit(1);
}, ms).unref();
