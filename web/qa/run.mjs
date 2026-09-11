// Starts a local static server, runs the smoke test against it, and tears
// the server down afterward — regardless of OS shell (avoids relying on
// backgrounding/job-control syntax that isn't portable across shells).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8734;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

await run('npm', ['run', 'generate-data'], { cwd: webRoot });

const server = spawn('npx', ['serve', '-l', String(PORT), '.'], { cwd: webRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500)); // let it bind

let exitCode = 0;
try {
  await run('node', ['qa/smoke-test.mjs'], { cwd: webRoot, env: { ...process.env, QA_BASE_URL: `http://127.0.0.1:${PORT}` } });
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  server.kill();
}
process.exit(exitCode);
