import { loadComponentPackage, type ComponentPackage, type LoadedComponent } from './component.js';
import { CodexSimulator, type Simulator } from './codex.js';
import { ComponentRuntime } from './runtime.js';
import { executeWorkflow, validateWorkflow, type Workflow, type StepResult } from './workflow.js';

export interface WorkspaceBundle {
  format: 'xentropy-workspace'; version: 1; components: ComponentPackage[]; workflow: Workflow;
}
export interface LoadedWorkspace { bundle: WorkspaceBundle; components: Map<string, LoadedComponent> }
export function loadWorkspace(value: unknown): LoadedWorkspace {
  const bundle = structuredClone(value) as WorkspaceBundle;
  if (!bundle || bundle.format !== 'xentropy-workspace' || bundle.version !== 1) throw new Error('Expected an xentropy-workspace version 1 bundle.');
  if (Buffer.byteLength(JSON.stringify(bundle)) > 1024 * 1024) throw new Error('Workspace exceeds 1 MiB.');
  if (!Array.isArray(bundle.components) || bundle.components.length < 1 || bundle.components.length > 40) throw new Error('Provide 1–40 components.');
  validateWorkflow(bundle.workflow);
  const components = new Map<string, LoadedComponent>();
  for (const pkg of bundle.components) {
    const component = loadComponentPackage(pkg);
    if (components.has(component.definition.id)) throw new Error(`Duplicate component: ${component.definition.id}`);
    components.set(component.definition.id, component);
  }
  for (const step of bundle.workflow.steps) {
    const component = components.get(step.component);
    if (!component) throw new Error(`Missing component: ${step.component}`);
    if (step.mode !== 'simulate' && !component.definition.real) throw new Error(`Configure a real endpoint for ${step.component}, or select simulate.`);
    if (step.scenario && !Object.hasOwn(component.definition.scenarios ?? {}, step.scenario)) throw new Error(`Unknown scenario for ${step.component}: ${step.scenario}`);
    if (!component.responses.has(step.expect.status)) throw new Error(`Undeclared expected status for ${step.component}: ${step.expect.status}`);
    for (const binding of Object.values(step.bindings ?? {})) {
      const upstream = bundle.workflow.steps.find(s => s.id === binding.step)!;
      const source = components.get(upstream.component)!;
      const schema = source.definition.operation.responses[String(upstream.expect.status)];
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (properties && !Object.hasOwn(properties, binding.field) && schema.additionalProperties === false) throw new Error(`Binding field is not in the upstream contract: ${binding.step}.${binding.field}`);
    }
  }
  return {bundle, components};
}
export async function runWorkspace(value: unknown, options: {
  model?: string; simulator?: Simulator; signal?: AbortSignal;
  onStep?: Parameters<typeof executeWorkflow>[2];
} = {}) {
  options.signal?.throwIfAborted();
  const {bundle, components} = loadWorkspace(value);
  const simulator = options.simulator ?? new CodexSimulator(undefined, options.model);
  return executeWorkflow(bundle.workflow, async (step, input): Promise<StepResult> => {
    options.signal?.throwIfAborted();
    const result = await new ComponentRuntime(components.get(step.component)!, simulator)
      .invoke(input, {mode: step.mode, scenario: step.scenario, signal: options.signal});
    if (result.body === null || typeof result.body !== 'object' || Array.isArray(result.body)) throw new Error('Workflow response bodies must be JSON objects.');
    return {...result, body: result.body as Record<string, unknown>, input: structuredClone(input)};
  }, options.onStep);
}
