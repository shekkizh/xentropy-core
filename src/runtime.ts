import { randomUUID } from 'node:crypto';
import type { LoadedComponent } from './component.js';
import { SimulationError, type ComponentResponse, type Simulator } from './codex.js';
export type Mode = 'simulate' | 'real' | 'auto';
export class InvocationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export class ComponentRuntime {
  constructor(public readonly component: LoadedComponent, private readonly simulator: Simulator, private readonly fetcher: typeof fetch = fetch) {}
  async invoke(input: unknown, options: { mode?: Mode; scenario?: string; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const { definition } = this.component;
    const mode = options.mode ?? 'simulate';
    if (!['simulate', 'real', 'auto'].includes(mode)) throw new InvocationError(400, 'invalid_mode', 'Unknown execution mode');
    if (!this.component.input(input)) throw new InvocationError(400, 'invalid_input', 'Input does not match component contract');
    let response: ComponentResponse;
    let source: 'real' | 'codex';
    let fallbackReason: string | undefined;
    let scenario: string | undefined;
    if (options.scenario !== undefined) {
      if (mode !== 'simulate') throw new InvocationError(400, 'invalid_scenario_mode', 'Scenarios require simulate mode');
      scenario = Object.hasOwn(definition.scenarios ?? {}, options.scenario) ? definition.scenarios![options.scenario].description : undefined;
      if (!scenario) throw new InvocationError(400, 'unknown_scenario', 'Unknown scenario');
    }
    {
      let realResponse: ComponentResponse | undefined;
      if (mode !== 'simulate') {
        const real = definition.real;
        if (!real) throw new InvocationError(400, 'missing_real', 'No real service configured');
        const signal = AbortSignal.any([AbortSignal.timeout(real.timeoutMs), ...(options.signal ? [options.signal] : [])]);
        try {
          const upstream = await this.fetcher(real.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal, redirect: 'error' });
          if (mode === 'auto' && real.fallbackStatuses.includes(upstream.status)) {
            fallbackReason = `upstream_status_${upstream.status}`;
            await upstream.body?.cancel();
          } else {
            try { realResponse = { status: upstream.status, body: await upstream.json() }; }
            catch (error) {
              // Fetch resolves at the headers. Its timeout must also cover reading
              // the body, while malformed JSON must never become a fallback.
              if (signal.aborted) throw error;
              throw new InvocationError(502, 'invalid_upstream_response', 'Real service did not return JSON');
            }
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof InvocationError) throw error;
          fallbackReason ??= signal.aborted ? 'upstream_timeout' : 'upstream_unreachable';
        }
        if (fallbackReason && (mode === 'real' || !real.safeToFallback)) {
          throw new InvocationError(502, fallbackReason, 'Real service failed; simulation fallback is not enabled for this call');
        }
      }
      if (realResponse) { response = realResponse; source = 'real'; }
      else {
        const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(options.signal ? [options.signal] : [])]);
        try { response = await this.simulator.simulate(this.component, input, signal, scenario); }
        catch (error) {
          options.signal?.throwIfAborted();
          throw new InvocationError(signal.aborted ? 504 : 502, 'simulation_failed', error instanceof SimulationError ? error.message : 'Codex did not produce a valid response');
        }
        source = 'codex';
      }
    }
    if (!response || !Number.isInteger(response.status) || !this.component.responses.get(response.status)?.(response.body)) {
      throw new InvocationError(502, 'invalid_output', 'Response does not match component contract');
    }
    return { status: response.status, body: response.body, trace: { requestId: randomUUID(), component: definition.id, version: definition.version,
      revision: this.component.revision, source, fallbackReason, durationMs: Date.now() - started, execution: response.execution } };
  }
}
