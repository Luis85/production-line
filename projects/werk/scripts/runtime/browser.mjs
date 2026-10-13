import { spawn } from 'node:child_process';

/** Injectable launcher; no shell, URL credentials, detached polling or secret-bearing URL. */
export async function openBrowser(url, { platform = process.platform, launch = spawn, timeoutMs = 3000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.search || target.hash) throw Error('Browser target must be a clean loopback HTTP URL.');
  const command = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : platform === 'linux' ? ['xdg-open', [url]] : null;
  if (!command) return { opened: false, reason: 'Automatic browser opening is unavailable on this platform.', url };
  return new Promise(resolve => {
    let child, done = false;
    const finish = (opened, reason) => { if (done) return; done = true; clearTimeout(timer); resolve({ opened, ...(reason ? { reason } : {}), url }); };
    const timer = setTimeout(() => { child?.kill(); finish(false, 'Browser launch timed out. Open the URL manually.'); }, timeoutMs);
    try { child = launch(command[0], command[1], { shell: false, stdio: 'ignore', windowsHide: true }); }
    catch { finish(false, 'Browser launch failed. Open the URL manually.'); return; }
    child.once('error', () => finish(false, 'Browser launch failed. Open the URL manually.'));
    child.once('close', code => finish(code === 0, code === 0 ? undefined : 'Browser launch failed. Open the URL manually.'));
  });
}
