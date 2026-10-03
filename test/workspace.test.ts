import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadComponentPackage, loadWorkspace, runWorkspace, WorkflowFailure } from '../src/index.js';
import type { WorkspaceBundle } from '../src/workspace.js';

const example = async (): Promise<WorkspaceBundle> => JSON.parse(await readFile(new URL('../examples/document-pipeline.json', import.meta.url), 'utf8'));
test('portable exports load without source directories, credentials or model calls', async () => {
  const bundle = await example();
  const loaded = loadWorkspace(bundle);
  assert.equal(loaded.components.size, 4);
  assert.equal(loaded.bundle.workflow.steps.length, 4);
  const component = loaded.components.get('aws-s3')!;
  const fromPackage = loadComponentPackage(bundle.components[0]);
  assert.equal(component.revision, fromPackage.revision);
  bundle.components[0].documents['spec.md'] = 'Changed after loading';
  assert.notEqual(component.documents[0].text, 'Changed after loading');
});
test('invalid versions, duplicate components and missing documents fail before execution', async () => {
  const bundle = await example();
  assert.throws(() => loadWorkspace({...bundle, version: 2}), /version 1/);
  assert.throws(() => loadWorkspace({...bundle, components: [...bundle.components, bundle.components[0]]}), /Duplicate component/);
  const missing = structuredClone(bundle);
  delete missing.components[0].documents['spec.md'];
  assert.throws(() => loadWorkspace(missing), /context document/);
  const escape = structuredClone(bundle);
  escape.components[0].documents['../private.txt'] = 'not selected';
  assert.throws(() => loadWorkspace(escape), /safe relative/);
  const undeclared = structuredClone(bundle);
  undeclared.workflow.steps[1].bindings!.objectUri.field = 'missing';
  assert.throws(() => loadWorkspace(undeclared), /upstream contract/);
});
test('workspace runtime resolves every dependency and checks actual results', async () => {
  const bundle = await example();
  const inputs: Record<string, unknown>[] = [];
  const result = await runWorkspace(bundle, {simulator: {simulate: async (component, input) => {
    const value = input as Record<string, unknown>;
    inputs.push(structuredClone(value));
    const bodies: Record<string, Record<string, unknown>> = {
      'aws-s3': {bucket: value.bucket, key: value.key, objectUri: `s3://${value.bucket}/${value.key}`, accepted: true},
      'aws-eventbridge': {accepted: true, failedEntryCount: 0, event: {source: value.source, objectUri: value.objectUri}},
      'aws-lambda': {processed: true, objectUri: (value.event as any)?.objectUri, message: `Processed ${(value.event as any)?.objectUri}`},
      'aws-sqs': {queue: value.queue, message: value.message, accepted: true}
    };
    return {status: 200, body: bodies[component.definition.id]};
  }}});
  assert.equal(result.passed, true);
  assert.deepEqual(inputs[1], {bus: 'documents', source: 'documents.uploaded', objectUri: 's3://demo-documents/reports/q3.txt'});
  assert.deepEqual(inputs[2].event, {source: 'documents.uploaded', objectUri: 's3://demo-documents/reports/q3.txt'});
  assert.equal(result.steps.enqueue.input?.message, result.steps.process.body.message);
  const bad = structuredClone(bundle);
  bad.workflow.steps[0].expect.body!.accepted = false;
  await assert.rejects(runWorkspace(bad, {simulator: {simulate: async () => ({status: 200, body: {bucket: 'demo-documents', key: 'reports/q3.txt', objectUri: 's3://demo-documents/reports/q3.txt', accepted: true}})}}), WorkflowFailure);
});
