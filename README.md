# Xentropy core

Turn a component's JSON contract and selected context into a callable simulation,
then test a workflow before its real dependencies exist. This package contains
the component loader, Codex simulator, execution modes, workflow engine, and a
command-line runner for portable workspaces. It runs independently of the website,
visual editor, account UI, workspace database, and hosted platform.

## First run

Requires Node.js 22+, npm, macOS or Linux, and a Codex account for simulations.
Validation and real-service execution do not need a Codex login.

```sh
git clone https://github.com/shekkizh/xentropy-core.git
cd xentropy-core
npm ci

# Validate the bundled, portable workspace without making model calls.
node bin/xentropy.mjs validate examples/document-pipeline.json

# Sign in with YOUR account, then run with a model available to that account.
npx codex login
node bin/xentropy.mjs run examples/document-pipeline.json \
  --model <your-model-id> --trace document-trace.json
```

The example connects four bounded JSON adapter contracts: S3 → EventBridge →
Lambda → SQS. All four steps are Codex simulations. They create no AWS resources
and persist no objects or messages. A successful run checks every response and
ends with `{"queue":"processed-documents","message":"Processed s3://demo-documents/reports/q3.txt","accepted":true}`.
The reference context defines this result; assertions are not sent to Codex.

`npm ci` builds the executable and TypeScript declarations through `prepare`.
If you install with scripts disabled, run `npm run build` before using the CLI.

## Use an exported workflow in another project

Install the tagged GitHub source release; no private-repository access is needed:

```sh
npm install git+https://github.com/shekkizh/xentropy-core.git#v0.1.0
npx xentropy validate ./xentropy-workspace.json
npx codex login
npx xentropy run ./xentropy-workspace.json \
  --model <your-model-id> --trace ./workflow-trace.json
```

`xentropy-workspace.json` is the version 1 export from the visual builder. It
includes component contracts, selected context documents, step inputs, upstream
bindings, scenarios, and expected responses. The CLI loads it directly; no
Xentropy server, browser, or agent registration is required. Each user supplies
their own Codex authentication. Credentials are not part of an exported workspace.

The GitHub release also provides an npm-installable `.tgz` built from this source.
The package is not yet published to the npm registry; use the Git URL or release
tarball rather than `npm install @xentropy/core`.

## Command-line interface

```text
xentropy validate <workspace.json>
xentropy run <workspace.json> [--model <model-id>] [--trace <trace.json>]
```

Progress is printed to stderr. The JSON report goes to stdout and, when requested,
the trace file. Reports retain actual results, resolved inputs, execution source,
revision, timing, and available Codex usage metadata. Failed assertions return
exit code 1 and retain the actual failed response and completed steps. Invalid
input or output-file errors return 2; cancellation returns 130.

`--model` overrides `CODEX_MODEL`; otherwise the Codex runner uses its default.
The simulation adapter ignores user configuration and uses fresh ephemeral
threads, so a model saved in personal Codex configuration is not inherited.
Account authentication and inference access are still required. Usage belongs to
the caller's Codex account or configured API credentials.

## JavaScript and TypeScript API

```js
import { readFile } from 'node:fs/promises';
import { loadWorkspace, runWorkspace } from '@xentropy/core';

const workspace = JSON.parse(await readFile('./xentropy-workspace.json', 'utf8'));
loadWorkspace(workspace); // Contract, context and binding validation; no inference.
const report = await runWorkspace(workspace, {
  model: process.env.CODEX_MODEL,
  signal: AbortSignal.timeout(180_000),
});
console.log(report.passed, report.steps);
```

For a single component:

```js
import { loadComponent, CodexSimulator, ComponentRuntime } from '@xentropy/core';

const component = await loadComponent('./service/component.json');
const runtime = new ComponentRuntime(component, new CodexSimulator());
const result = await runtime.invoke({ sku: 'WIDGET-1', quantity: 2 }, {
  mode: 'simulate',
});
console.log(result.status, result.body, result.trace);
```

| Export | Responsibility |
| --- | --- |
| `loadComponent` / `loadComponentPackage` | Load a contract and selected text context from files or an embedded package. |
| `ComponentRuntime` | Validate inputs/outputs and invoke the selected implementation. |
| `CodexSimulator` / `Simulator` | Local Codex execution, or a caller-provided execution adapter. |
| `validateWorkflow` / `executeWorkflow` | Validate dependencies, resolve bindings and assert actual responses. |
| `runWorkflow` | Execute a workflow through existing component HTTP `/invoke` endpoints. |
| `loadWorkspace` / `runWorkspace` | Validate and execute the same portable export used by the visual builder. |

Types, `InvocationError`, `SimulationError`, `WorkflowFailure`, `simulationPrompt`,
and `SANDBOX_POLICY` are exported too. `@xentropy/core/sandbox` exposes the fixed
Codex policy helpers for application adapters.

## Execution behavior

- `simulate` always invokes Codex with the selected contract, context, request,
  and scenario. Expected workflow responses are checked afterward.
- `real` POSTs to the component's configured HTTP(S) endpoint and validates its
  response against the same contract.
- `auto` tries that endpoint and falls back only on permitted unavailability
  when `safeToFallback` is true. Invalid JSON and invalid outputs are failures.

Workflows execute sequentially. Bindings copy top-level fields from earlier
response bodies into later requests. They support multiple dependencies and
object-valued fields; loops, branching, parallel scheduling, and durable
simulated state are not implemented. Workspace JSON is limited to 1 MiB,
1–40 components, 1–20 steps, and 256 KiB of text context per component.

Real calls happen in the application process, outside Codex's read-only sandbox.
Configure endpoints appropriate to your own environment. URLs from someone
else's workspace may point to their localhost services. The platform's bundled
`xentropy-demo.invalid` inventory marker is not resolved by this standalone
package; replace it with your own endpoint or use a simulated workflow.

Each simulated invocation gets a temporary read-only workspace and ephemeral
conversation. Host tools, command network access, and web search are disabled.
Model/authentication traffic remains available. This is a local permission
policy; it is not isolation between hosted tenants. JSON Schema validity alone
does not establish fidelity for every input.

## Development and consumer verification

```sh
npm ci
npm run check
npm test
npm run test:package
```

Unit tests exercise contracts, scenarios, timeouts, fallback, cancellation,
bindings and failures without model inference. `test:package` packs the package,
installs it into an unrelated temporary project, checks the public API and CLI,
and runs a workflow against real local HTTP services. It verifies failure traces
and does not need a Codex login. CI runs this consumer test on Node 22/24 and
macOS/Linux. Live model runs are deliberately separate and use your account.

The only runtime dependencies are the official Codex CLI/SDK and Ajv. See
[CONTRIBUTING.md](CONTRIBUTING.md) for changes and [SECURITY.md](SECURITY.md) for
reporting a vulnerability. Licensed under [Apache-2.0](LICENSE).
