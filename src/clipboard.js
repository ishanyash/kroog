// The clipboard on this computer. Kroog runs here, so it can put the context for a new chat on
// the clipboard itself, which is the one thing that always works: you paste, press Enter.
import { spawn } from 'node:child_process';

function tryCopy(cmd, args, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => { /* the close event says */ });
    child.stdin.end(String(text || ''));
  });
}

export async function copyText(text, { platform = process.platform } = {}) {
  if (platform === 'darwin') return tryCopy('pbcopy', [], text);
  if (platform === 'win32') return tryCopy('clip', [], text);
  if (await tryCopy('wl-copy', [], text)) return true;
  return tryCopy('xclip', ['-selection', 'clipboard'], text);
}
