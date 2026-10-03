import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'xentropy-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let server;
try {
  const packed = await execute(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {cwd: root});
  const parsed = JSON.parse(packed.stdout);
  const [manifest] = Array.isArray(parsed) ? parsed : parsed.files ? [parsed] : Object.values(parsed);
  const files = manifest.files.map(file => file.path);
  assert.ok(files.includes('LICENSE') && files.includes('NOTICE') && files.includes('dist/index.js') && files.includes('dist/codex-exec.mjs'));
  assert.ok(files.every(path => ['LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(path) || /^(dist|bin|examples)\//.test(path)));
  await writeFile(join(directory, 'package.json'), JSON.stringify({name: 'independent-consumer', private: true, type: 'module'}));
  await execute(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(directory, manifest.filename)], {cwd: directory});
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/@xentropy/core/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(installed.dependencies).sort(), ['@openai/codex', '@openai/codex-sdk', 'ajv']);
  assert.equal(installed.license, 'Apache-2.0');
  assert.equal(installed.private, undefined);
  await copyFile(join(root, 'examples/document-pipeline.json'), join(directory, 'workspace.json'));
  await writeFile(join(directory, 'consumer.mjs'), `import {loadWorkspace, ComponentRuntime, CodexSimulator} from '@xentropy/core';
import {readFile} from 'node:fs/promises';
const workspace = loadWorkspace(JSON.parse(await readFile('workspace.json', 'utf8')));
if (workspace.components.size !== 4 || typeof ComponentRuntime !== 'function' || typeof CodexSimulator !== 'function') throw Error('Public imports failed');
console.log('Consumer API passed');\n`);
  await execute(process.execPath, ['consumer.mjs'], {cwd: directory});
  const cli = join(directory, 'node_modules/@xentropy/core/bin/xentropy.mjs');
  const help = await execute(process.execPath, [cli, '--help'], {cwd: directory});
  assert.match(help.stdout, /xentropy run/);
  const validation = await execute(process.execPath, [cli, 'validate', 'workspace.json'], {cwd: directory});
  assert.equal(JSON.parse(validation.stdout).valid, true);
  const malformed = {...JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')), version: 99};
  await writeFile(join(directory, 'invalid.json'), JSON.stringify(malformed));
  await assert.rejects(execute(process.execPath, [cli, 'validate', 'invalid.json'], {cwd: directory}), error => error.code === 2 && /version 1/.test(error.stderr));

  // Actual HTTP services exercise packaged execution and bindings without login.
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({value: request.url === '/double' ? input.value * 2 : input.value + input.increment}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const outputSchema = {type: 'object', additionalProperties: false, required: ['value'], properties: {value: {type: 'integer'}}};
  const pkg = (id, inputSchema) => ({definition: {id, version: '1.0.0', description: 'Independent consumer HTTP service', context: ['spec.md'],
    operation: {name: id, path: `/${id}`, inputSchema, responses: {'200': outputSchema}},
    real: {url: `${url}/${id}`, timeoutMs: 2000, fallbackStatuses: [], safeToFallback: false}}, documents: {'spec.md': 'The service returns its computed integer value.'}});
  const inputSchema = {type: 'object', additionalProperties: false, required: ['value'], properties: {value: {type: 'integer'}}};
  const workspace = {format: 'xentropy-workspace', version: 1,
    components: [pkg('double', inputSchema), pkg('add', {...inputSchema, required: ['value', 'increment'], properties: {...inputSchema.properties, increment: {type: 'integer'}}})],
    workflow: {name: 'Independent consumer', steps: [
      {id: 'first', component: 'double', mode: 'real', input: {value: 3}, expect: {status: 200, source: 'real', body: {value: 6}}},
      {id: 'second', component: 'add', mode: 'real', input: {increment: 5}, bindings: {value: {step: 'first', field: 'value'}}, expect: {status: 200, source: 'real', body: {value: 11}}}
    ]}};
  await writeFile(join(directory, 'real-workspace.json'), JSON.stringify(workspace));
  const run = await execute(process.execPath, [cli, 'run', 'real-workspace.json', '--trace', 'consumer-trace.json'], {cwd: directory});
  const report = JSON.parse(run.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.steps.second.input.value, 6);
  assert.equal(report.steps.second.body.value, 11);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'consumer-trace.json'), 'utf8')), report);
  workspace.workflow.steps[1].expect.body.value = 12;
  await writeFile(join(directory, 'real-workspace.json'), JSON.stringify(workspace));
  await assert.rejects(execute(process.execPath, [cli, 'run', 'real-workspace.json', '--trace', 'failed-trace.json'], {cwd: directory}), error => {
    const report = JSON.parse(error.stdout);
    return error.code === 1 && report.passed === false && report.failedStep === 'second' && report.actual.body.value === 11;
  });
  console.log(`Independent package consumer passed (${files.length} packed files; public API, validate, real workflow, failure trace).`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
