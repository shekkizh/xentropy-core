import type { CodexOptions } from '@openai/codex-sdk';

// A local Codex permission policy, not a container or a tenant-isolation boundary.
// The host runtime makes configured real-service calls outside this policy.
export const SANDBOX_POLICY = Object.freeze({
  id: 'codex-read-only-v1',
  provider: 'openai-codex',
  execution: 'local',
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  commandNetworkAccess: false,
  webSearch: 'disabled',
  hostTools: 'disabled',
  workspace: 'temporary-per-invocation',
  conversation: 'ephemeral',
  hostedTenantIsolation: false,
  realServiceRequests: 'outside-codex-sandbox'
} as const);

export type SimulationSandbox = typeof SANDBOX_POLICY;

/** The fixed subset of Codex thread settings used by a component invocation. */
export interface SimulationThreadOptions {
  model?: string;
  workingDirectory: string;
  skipGitRepoCheck: true;
  sandboxMode: 'read-only';
  approvalPolicy: 'never';
  networkAccessEnabled: false;
  webSearchMode: 'disabled';
}

// Keep the SDK and app-server paths on the same restricted surface. No user-
// supplied context, component definition or workflow can widen these settings.
export const SIMULATION_CONFIG = Object.freeze({
  project_doc_max_bytes: 0,
  web_search: 'disabled',
  sandbox_mode: 'read-only',
  approval_policy: 'never',
  sandbox_workspace_write: Object.freeze({ network_access: false }),
  features: Object.freeze({
    shell_tool: false, apply_patch_freeform: false, apps: false, plugins: false,
    browser_use: false, browser_use_external: false, computer_use: false,
    multi_agent: false, view_image: false, image_generation: false, hooks: false,
    memories: false, skill_search: false, skip_host_skill_discovery: true
  })
} satisfies NonNullable<CodexOptions['config']>);

export function simulationThreadOptions(workingDirectory: string, model?: string): SimulationThreadOptions {
  return { model, workingDirectory, skipGitRepoCheck: true,
    sandboxMode: SANDBOX_POLICY.sandboxMode, approvalPolicy: SANDBOX_POLICY.approvalPolicy,
    networkAccessEnabled: SANDBOX_POLICY.commandNetworkAccess, webSearchMode: SANDBOX_POLICY.webSearch };
}

export function simulationConfigArguments(): string[] {
  const flatten = (config: Record<string, unknown>, prefix = ''): string[] => Object.entries(config).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object'
      ? flatten(value as Record<string, unknown>, path)
      : ['-c', `${path}=${JSON.stringify(value)}`];
  });
  return flatten(SIMULATION_CONFIG);
}

// Explicit turn policy prevents future app-server default changes from granting
// command network access. Model and authentication traffic remains available.
export const APP_SERVER_SANDBOX = Object.freeze({ type: 'readOnly', networkAccess: false });
