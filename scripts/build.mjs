import { chmod, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), {recursive: true, force: true});
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '--project', 'tsconfig.json'], {cwd: root, stdio: 'inherit'});
await copyFile(new URL('../src/codex-exec.mjs', import.meta.url), new URL('../dist/codex-exec.mjs', import.meta.url));
await chmod(new URL('../dist/codex-exec.mjs', import.meta.url), 0o755);
await chmod(new URL('../bin/xentropy.mjs', import.meta.url), 0o755);
