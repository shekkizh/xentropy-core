import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadWorkspace, runWorkspace } from './workspace.js';
import { WorkflowFailure } from './workflow.js';

const help = `Usage:
  xentropy validate <workspace.json>
  xentropy run <workspace.json> [--model <model-id>] [--trace <trace.json>]

Accepts the version 1 xentropy-workspace export from the visual builder.
Validation needs no login. Simulation uses your own Codex CLI authentication.
Run "npx codex login" first; model access and usage belong to your account.
Real/auto steps call the endpoint declared in the workspace.
Progress goes to stderr; the completed report goes to stdout and --trace.
`;

async function saveTrace(file: string, report: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await rename(temporary, file);
  } finally { await rm(temporary, {force: true}); }
}

export async function main(args = process.argv.slice(2)) {
  let trace: string | undefined;
  let report: unknown;
  let exitCode = 2;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Workflow cancelled.'));
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
      help: {type: 'boolean', short: 'h'}, model: {type: 'string'}, trace: {type: 'string'}
    }});
    if (values.help || !positionals.length) { exitCode = 0; process.stdout.write(help); return; }
    const [command, file] = positionals;
    if (!['validate', 'run'].includes(command) || !file || positionals.length !== 2) throw new Error(help);
    if (command === 'validate' && (values.model || values.trace)) throw new Error('Model and trace options apply to run only.');
    if (values.model !== undefined && !values.model.trim()) throw new Error('Model ID cannot be empty.');
    trace = values.trace ? resolve(values.trace) : undefined;
    if (trace === resolve(file)) throw new Error('Trace output must be different from the workspace file.');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Workspace exceeds 1 MiB.');
    const value: unknown = JSON.parse(text);
    const {bundle} = loadWorkspace(value);
    if (command === 'validate') {
      report = {valid: true, name: bundle.workflow.name, steps: bundle.workflow.steps.length, components: bundle.components.length};
      exitCode = 0;
    } else {
      const startedAt = new Date().toISOString();
      exitCode = 1;
      try {
        const result = await runWorkspace(bundle, {
          model: values.model, signal: controller.signal,
          onStep: async event => {
            const detail = event.result ? ` HTTP ${event.result.status} / ${event.result.trace.source}` : '';
            process.stderr.write(`${event.step}: ${event.state}${detail}\n`);
          }
        });
        report = {...result, model: values.model ?? process.env.CODEX_MODEL ?? 'codex-default', startedAt, finishedAt: new Date().toISOString()};
        exitCode = 0;
      } catch (error) {
        if (!(error instanceof WorkflowFailure)) throw error;
        report = {passed: false, model: values.model ?? process.env.CODEX_MODEL ?? 'codex-default', startedAt,
          finishedAt: new Date().toISOString(), error: error.message, ...error.details};
        exitCode = controller.signal.aborted ? 130 : 1;
      }
    }
    if (trace) await saveTrace(trace, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (exitCode === 0) exitCode = 2;
    process.stderr.write(`${error instanceof Error ? error.message : 'Command failed.'}\n`);
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    process.exitCode = exitCode;
  }
}
