import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import type { Mode } from './runtime.js';
export interface WorkflowStep {
  id: string;
  component: string;
  mode: Mode;
  scenario?: string;
  input: Record<string, unknown>;
  bindings?: Record<string, { step: string; field: string }>;
  expect: { status: number; source?: 'real' | 'codex'; body?: Record<string, unknown> };
}
export interface Workflow { name: string; steps: WorkflowStep[] }
export interface StepResult { status: number; body: Record<string, unknown>; input?: Record<string, unknown>; trace: { source: string; [key: string]: unknown } }
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile({
  type: 'object', additionalProperties: false, required: ['name', 'steps'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    steps: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['id', 'component', 'mode', 'input', 'expect'], properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, component: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
        mode: { enum: ['real', 'simulate', 'auto'] }, scenario: { type: 'string' }, input: { type: 'object' },
        bindings: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, required: ['step', 'field'], properties: { step: { type: 'string' }, field: { type: 'string' } } } },
        expect: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'integer', minimum: 200, maximum: 599 }, source: { enum: ['real', 'codex'] }, body: { type: 'object' } } }
      }
    } }
  }
});
export function validateWorkflow(value: unknown): asserts value is Workflow {
  if (!validate(value)) throw new Error(`Invalid workflow: ${ajv.errorsText(validate.errors)}`);
  const ids = new Set<string>();
  for (const step of (value as Workflow).steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate step: ${step.id}`);
    if (step.scenario && step.mode !== 'simulate') throw new Error('Scenarios require simulate mode.');
    for (const binding of Object.values(step.bindings ?? {})) if (!ids.has(binding.step)) throw new Error(`Binding must refer to an earlier step: ${binding.step}`);
    ids.add(step.id);
  }
}
export class WorkflowFailure extends Error {
  constructor(message: string, public readonly details: { name: string; completedSteps: Record<string, StepResult>; failedStep: string; actual?: StepResult }) { super(message); }
}
export async function executeWorkflow(workflow: Workflow, invoke: (step: WorkflowStep, input: Record<string, unknown>) => Promise<StepResult>, onStep?: (event: { step: string; state: 'running' | 'passed'; result?: StepResult }) => Promise<void>) {
  validateWorkflow(workflow);
  const steps: Record<string, StepResult> = Object.create(null);
  for (const step of workflow.steps) {
    let result: StepResult | undefined;
    try {
      await onStep?.({ step: step.id, state: 'running' });
      const input = structuredClone(step.input);
      for (const [field, binding] of Object.entries(step.bindings ?? {})) {
        const previous = steps[binding.step];
        if (!previous || !Object.hasOwn(previous.body, binding.field)) throw new Error(`Missing binding: ${binding.step}.${binding.field}`);
        Object.defineProperty(input, field, { value: previous.body[binding.field], enumerable: true, configurable: true, writable: true });
      }
      result = await invoke(step, input);
      if (result.status !== step.expect.status || (step.expect.source !== undefined && result.trace?.source !== step.expect.source)) throw new Error(`Step ${step.id}: expected ${step.expect.status}/${step.expect.source ?? "either source"}, got ${result.status}/${result.trace?.source}`);
      for (const [key, value] of Object.entries(step.expect.body ?? {})) {
        if (!Object.hasOwn(result.body, key) || !isDeepStrictEqual(result.body[key], value)) throw new Error(`Step ${step.id}: unexpected body field ${key}`);
      }
      steps[step.id] = result;
      await onStep?.({ step: step.id, state: 'passed', result });
    } catch (error) {
      throw new WorkflowFailure(error instanceof Error ? error.message : 'Workflow failed', { name: workflow.name, completedSteps: steps, failedStep: step.id, actual: result });
    }
  }
  return { name: workflow.name, passed: true, steps };
}
export async function runWorkflow(workflow: Workflow, endpoints: Record<string, string>) {
  return executeWorkflow(workflow, async (step, input) => {
    if (!Object.hasOwn(endpoints, step.component)) throw new Error(`Missing endpoint: ${step.component}`);
    const response = await fetch(new URL('/invoke', endpoints[step.component]), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, mode: step.mode, ...(step.scenario === undefined ? {} : { scenario: step.scenario }) }), signal: AbortSignal.timeout(125000)
    });
    if (!response.ok) {
      const failure = await response.json() as { error?: { code?: string } };
      throw new Error(`Step ${step.id}: runtime HTTP ${response.status} (${failure.error?.code ?? 'unknown_error'})`);
    }
    return await response.json() as StepResult;
  });
}
