import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { loadComponent, type ComponentDefinition } from '../src/component.js';
import { CodexSimulator, simulationPrompt, type ComponentResponse, type Simulator } from '../src/codex.js';
import { SANDBOX_POLICY } from '../src/sandbox.js';
import { ComponentRuntime, InvocationError } from '../src/runtime.js';
import { executeWorkflow, validateWorkflow, WorkflowFailure, type Workflow, type StepResult } from '../src/workflow.js';

const input = { sku: 'WIDGET-1', quantity: 2 };
const available = { sku: 'WIDGET-1', available: 12, fulfillable: true };
async function inventory(real: Partial<NonNullable<ComponentDefinition['real']>> = {}) {
  return loadComponent(new URL('../examples/inventory/component.json', import.meta.url).pathname, {
    real: { url: 'http://127.0.0.1:4000/inventory/check', timeoutMs: 1000, fallbackStatuses: [503], safeToFallback: true, ...real }
  });
}
// These doubles exercise orchestration only. Production simulations still require Codex.
function simulator(response: ComponentResponse = { status: 200, body: available }) {
  const calls: { input: unknown; scenario?: string }[] = [];
  const implementation: Simulator = { simulate: async (_component, input, _signal, scenario) => {
    calls.push({ input, scenario });
    return structuredClone(response);
  } };
  return { implementation, calls };
}
const noFetch: typeof fetch = async () => { throw new Error('Unexpected upstream request'); };
function errorCode(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof InvocationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}
// Keep the stream open after the headers until the runtime's own deadline aborts.
const stalledBody: typeof fetch = async (_url, options) => {
  const signal = options?.signal;
  assert.ok(signal);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const deadline = setTimeout(() => controller.error(new Error('Test body did not abort')), 1000);
      const abort = () => { clearTimeout(deadline); controller.error(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  }), { status: 200 });
};

test('invalid inputs and scenario selections fail before a simulator or upstream is called', async () => {
  const stub = simulator();
  const runtime = new ComponentRuntime(await inventory(), stub.implementation, noFetch);
  await assert.rejects(runtime.invoke({ ...input, quantity: 0 }), errorCode(400, 'invalid_input'));
  await assert.rejects(runtime.invoke(input, { scenario: 'unknown' }), errorCode(400, 'unknown_scenario'));
  await assert.rejects(runtime.invoke(input, { mode: 'auto', scenario: 'unavailable' }), errorCode(400, 'invalid_scenario_mode'));
  assert.equal(stub.calls.length, 0);
});

test('simulation receives selected context and environmental scenario, with a validated failure response', async () => {
  const loaded = await inventory();
  const stub = simulator({ status: 503, body: { error: 'inventory_unavailable' } });
  const result = await new ComponentRuntime(loaded, stub.implementation, noFetch).invoke(input, { scenario: 'unavailable' });
  assert.equal(result.status, 503);
  assert.equal(result.trace.source, 'codex');
  assert.equal(result.trace.revision, loaded.revision);
  assert.equal(result.trace.fallbackReason, undefined);
  assert.deepEqual(stub.calls, [{ input, scenario: loaded.definition.scenarios!.unavailable.description }]);
  const { prompt } = simulationPrompt(loaded, input, stub.calls[0].scenario);
  assert.ok(prompt.includes(JSON.stringify(loaded.documents[0].text)));
  assert.ok(!prompt.includes(loaded.definition.real!.url));
});

test('real mode validates and preserves upstream success and documented application failure', async () => {
  const stub = simulator();
  for (const response of [{ status: 200, body: available }, { status: 404, body: { error: 'unknown_sku' } }]) {
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:4000/inventory/check');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(options?.body)), input);
      return Response.json(response.body, { status: response.status });
    };
    const result = await new ComponentRuntime(await inventory(), stub.implementation, fetcher).invoke(input, { mode: 'real' });
    assert.equal(result.status, response.status);
    assert.deepEqual(result.body, response.body);
    assert.equal(result.trace.source, 'real');
  }
  assert.equal(stub.calls.length, 0);
});

test('auto falls back for connection errors and configured upstream statuses with an explicit reason', async () => {
  const cases: { fetcher: typeof fetch; reason: string }[] = [
    { fetcher: async () => { throw new TypeError('Connection refused'); }, reason: 'upstream_unreachable' },
    { fetcher: async () => Response.json({ error: 'unavailable' }, { status: 503 }), reason: 'upstream_status_503' }
  ];
  for (const { fetcher, reason } of cases) {
    const stub = simulator();
    const result = await new ComponentRuntime(await inventory(), stub.implementation, fetcher).invoke(input, { mode: 'auto' });
    assert.equal(result.trace.source, 'codex');
    assert.equal(result.trace.fallbackReason, reason);
    assert.deepEqual(result.body, available);
    assert.equal(stub.calls.length, 1);
  }
});

test('a response body that stalls after headers permits safe timeout fallback', async () => {
  const stub = simulator();
  const result = await new ComponentRuntime(await inventory({ timeoutMs: 20 }), stub.implementation, stalledBody).invoke(input, { mode: 'auto' });
  assert.equal(result.trace.source, 'codex');
  assert.equal(result.trace.fallbackReason, 'upstream_timeout');
  assert.equal(stub.calls.length, 1);
});

test('real mode and unsafe operations never simulate after a whole-response timeout', async () => {
  for (const mode of ['real', 'auto'] as const) {
    const stub = simulator();
    const loaded = await inventory({ timeoutMs: 20, safeToFallback: false });
    await assert.rejects(new ComponentRuntime(loaded, stub.implementation, stalledBody).invoke(input, { mode }), errorCode(502, 'upstream_timeout'));
    assert.equal(stub.calls.length, 0);
  }
});

test('malformed JSON, schema violations and unlisted application failures do not become fallback', async () => {
  const cases: { fetcher: typeof fetch; code: string }[] = [
    { fetcher: async () => new Response('{broken', { status: 200 }), code: 'invalid_upstream_response' },
    { fetcher: async () => Response.json({ ...available, available: 'twelve' }), code: 'invalid_output' },
    { fetcher: async () => Response.json({ error: 'internal_error' }, { status: 500 }), code: 'invalid_output' }
  ];
  for (const { fetcher, code } of cases) {
    const stub = simulator();
    await assert.rejects(new ComponentRuntime(await inventory(), stub.implementation, fetcher).invoke(input, { mode: 'auto' }), errorCode(502, code));
    assert.equal(stub.calls.length, 0);
  }
  const stub = simulator();
  const result = await new ComponentRuntime(await inventory(), stub.implementation, async () => Response.json({ error: 'unknown_sku' }, { status: 404 })).invoke(input, { mode: 'auto' });
  assert.equal(result.status, 404);
  assert.equal(result.trace.source, 'real');
  assert.equal(stub.calls.length, 0);
});

test('a simulator cannot return the wrong status/body contract', async () => {
  for (const response of [{ status: 200, body: { error: 'unknown_sku' } }, { status: 201, body: available }]) {
    const stub = simulator(response);
    await assert.rejects(new ComponentRuntime(await inventory(), stub.implementation, noFetch).invoke(input), errorCode(502, 'invalid_output'));
  }
});

test('caller cancellation while reading an upstream body never starts fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('User cancelled this run');
  const stub = simulator();
  const fetcher: typeof fetch = async (url, options) => {
    const response = await stalledBody(url, options);
    controller.abort(reason);
    return response;
  };
  await assert.rejects(new ComponentRuntime(await inventory(), stub.implementation, fetcher).invoke(input, { mode: 'auto', signal: controller.signal }), error => error === reason);
  assert.equal(stub.calls.length, 0);
});

test('caller cancellation during simulation retains the original cancellation reason', async () => {
  const controller = new AbortController();
  const reason = new Error('User cancelled this run');
  const implementation: Simulator = { simulate: async (_component, _input, signal) => {
    controller.abort(reason);
    signal.throwIfAborted();
    throw new Error('Unreachable');
  } };
  await assert.rejects(new ComponentRuntime(await inventory(), implementation, noFetch).invoke(input, { signal: controller.signal }), error => error === reason);
});

test('Codex calls use fresh read-only workspaces, publish policy and clean up on success and failure', async () => {
  const workspaces: string[] = [];
  let fail = false;
  const failure = new Error('Provider rejected the turn');
  const codex = new CodexSimulator({ startThread(options) {
    assert.equal(options.sandboxMode, 'read-only');
    assert.equal(options.approvalPolicy, 'never');
    assert.equal(options.networkAccessEnabled, false);
    assert.equal(options.webSearchMode, 'disabled');
    assert.equal(Object.hasOwn(options, 'additionalDirectories'), false);
    assert.ok(options.workingDirectory);
    workspaces.push(options.workingDirectory);
    return { id: 'test-thread', run: async (_prompt, turn) => {
      assert.ok((await stat(options.workingDirectory!)).isDirectory());
      assert.ok(turn?.signal);
      if (fail) throw failure;
      return { items: [], finalResponse: JSON.stringify({ status: 200, body: available,
        execution: { sandbox: { sandboxMode: 'danger-full-access' } } }),
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
    } };
  } }, 'test-model');
  const loaded = await inventory();
  const result = await new ComponentRuntime(loaded, codex, noFetch).invoke(input);
  assert.deepEqual(result.trace.execution?.sandbox, SANDBOX_POLICY);
  assert.equal(result.trace.execution?.sandbox?.hostedTenantIsolation, false);
  assert.equal(result.trace.execution?.model, 'test-model');
  fail = true;
  await assert.rejects(codex.simulate(loaded, input, new AbortController().signal), error => error === failure);
  assert.equal(new Set(workspaces).size, 2);
  for (const workspace of workspaces) await assert.rejects(stat(workspace), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort(failure);
  await assert.rejects(codex.simulate(loaded, input, controller.signal), error => error === failure);
  assert.equal(workspaces.length, 2, 'cancelled requests must not create another Codex thread');
});

function workflow(): Workflow {
  return { name: 'Dependencies', steps: [
    { id: 'inventory', component: 'inventory', mode: 'real', input, expect: { status: 200, source: 'real' } },
    { id: 'shipping', component: 'shipping', mode: 'simulate', input: {}, bindings: { fulfillable: { step: 'inventory', field: 'fulfillable' } }, expect: { status: 200, source: 'codex', body: { quote: { currency: 'USD', amount: 700 } } } },
    { id: 'checkout', component: 'checkout', mode: 'simulate', input: {}, bindings: { sku: { step: 'inventory', field: 'sku' }, shipping: { step: 'shipping', field: 'quote' } }, expect: { status: 200, source: 'codex' } }
  ] };
}
const stepResult = (body: Record<string, unknown>, source = 'codex'): StepResult => ({ status: 200, body, trace: { source } });

test('workflow supports multiple dependencies and semantic object assertions without mutating its definition', async () => {
  const selected = workflow();
  const before = structuredClone(selected);
  const result = await executeWorkflow(selected, async (step, resolved) => {
    if (step.id === 'inventory') return stepResult(available, 'real');
    if (step.id === 'shipping') {
      assert.deepEqual(resolved, { fulfillable: true });
      return stepResult({ quote: { amount: 700, currency: 'USD' } });
    }
    assert.deepEqual(resolved, { sku: 'WIDGET-1', shipping: { amount: 700, currency: 'USD' } });
    return stepResult({ ready: true });
  });
  assert.equal(result.passed, true);
  assert.deepEqual(Object.keys(result.steps), ['inventory', 'shipping', 'checkout']);
  assert.deepEqual(selected, before);
});

test('missing bindings stop downstream execution and preserve completed steps', async () => {
  const selected = workflow();
  selected.steps[1].bindings!.fulfillable.field = 'absent';
  const invoked: string[] = [];
  await assert.rejects(executeWorkflow(selected, async step => {
    invoked.push(step.id);
    return stepResult(available, 'real');
  }), error => {
    assert.ok(error instanceof WorkflowFailure);
    assert.equal(error.details.failedStep, 'shipping');
    assert.deepEqual(Object.keys(error.details.completedSteps), ['inventory']);
    assert.match(error.message, /Missing binding: inventory.absent/);
    return true;
  });
  assert.deepEqual(invoked, ['inventory']);
});

test('assertion failure records the actual response and does not execute later dependencies', async () => {
  const invoked: string[] = [];
  await assert.rejects(executeWorkflow(workflow(), async step => {
    invoked.push(step.id);
    return step.id === 'inventory' ? stepResult(available, 'real') : stepResult({ quote: { amount: 999, currency: 'USD' } });
  }), error => {
    assert.ok(error instanceof WorkflowFailure);
    assert.equal(error.details.failedStep, 'shipping');
    assert.deepEqual(error.details.actual?.body, { quote: { amount: 999, currency: 'USD' } });
    assert.deepEqual(Object.keys(error.details.completedSteps), ['inventory']);
    return true;
  });
  assert.deepEqual(invoked, ['inventory', 'shipping']);
});

test('workflow validation rejects duplicate steps and forward references before execution', () => {
  const duplicate = workflow();
  duplicate.steps[1].id = 'inventory';
  assert.throws(() => validateWorkflow(duplicate), /Duplicate step/);
  const forward = workflow();
  forward.steps[0].bindings = { sku: { step: 'checkout', field: 'sku' } };
  assert.throws(() => validateWorkflow(forward), /earlier step/);
});


test('behavior assertions can remain unchanged when a workflow implementation is replaced', async () => {
  const workflow = { name: 'interchangeable', steps: [{ id: 'service', component: 'inventory', mode: 'simulate' as const, input: {}, expect: { status: 200, body: { value: 3 } } }] };
  for (const source of ['codex', 'real']) {
    const result = await executeWorkflow(workflow, async () => ({ status: 200, body: { value: 3 }, trace: { source } }));
    assert.equal(result.passed, true);
  }
  await assert.rejects(executeWorkflow(workflow, async () => ({ status: 200, body: { value: 4 }, trace: { source: 'real' } })), /unexpected body field/);
});
