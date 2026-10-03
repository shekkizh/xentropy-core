import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';

export type Schema = Record<string, unknown>;
export interface ComponentDefinition {
  id: string;
  version: string;
  description: string;
  context: string[];
  operation: {
    name: string;
    path: string;
    inputSchema: Schema;
    responses: Record<string, Schema>;
  };
  scenarios?: Record<string, { description: string }>;
  real?: { url: string; timeoutMs: number; fallbackStatuses: number[]; safeToFallback: boolean };
}
export interface LoadedComponent {
  definition: ComponentDefinition;
  documents: { path: string; text: string }[];
  revision: string;
  input: ValidateFunction;
  responses: Map<number, ValidateFunction>;
}
export interface ComponentPackage { definition: ComponentDefinition; documents: Record<string, string> }
const ajv = new Ajv({ allErrors: true, strict: true });
const definitionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'version', 'description', 'context', 'operation'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    version: { type: 'string', minLength: 1 }, description: { type: 'string' },
    context: { type: 'array', minItems: 1, items: { type: 'string' } },
    operation: {
      type: 'object', additionalProperties: false,
      required: ['name', 'path', 'inputSchema', 'responses'],
      properties: {
        name: { type: 'string', minLength: 1 }, path: { type: 'string', pattern: '^/[^:*]*$' },
        inputSchema: { type: 'object' },
        responses: { type: 'object', minProperties: 1, patternProperties: { '^[2-5][0-9]{2}$': { type: 'object' } }, additionalProperties: false }
      }
    },
    scenarios: { type: 'object', additionalProperties: {
      type: 'object', additionalProperties: false, required: ['description'],
      properties: { description: { type: 'string', minLength: 1 } }
    } },
    real: { type: 'object', additionalProperties: false, required: ['url', 'timeoutMs', 'fallbackStatuses', 'safeToFallback'],
      properties: { url: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        fallbackStatuses: { type: 'array', items: { type: 'integer', minimum: 500, maximum: 599 } }, safeToFallback: { type: 'boolean' } }
    }
  }
};
const validateDefinition = ajv.compile(definitionSchema);
const safeDocument = (path: string) => path.length > 0 && path !== 'component.json' && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(part => !part || part === '.' || part === '..');
export function loadComponentPackage(value: unknown): LoadedComponent {
  const pkg = structuredClone(value) as ComponentPackage;
  if (!pkg || !validateDefinition(pkg.definition)) throw new Error(`Invalid component: ${ajv.errorsText(validateDefinition.errors)}`);
  if (!pkg.documents || typeof pkg.documents !== 'object' || Array.isArray(pkg.documents)) throw new Error('Component documents must map paths to UTF-8 text.');
  let bytes = 0;
  for (const [path, text] of Object.entries(pkg.documents)) {
    if (!safeDocument(path) || typeof text !== 'string') throw new Error('Context documents need safe relative paths and text contents.');
    bytes += Buffer.byteLength(text);
  }
  if (bytes > 256 * 1024) throw new Error('Context exceeds 256 KiB; select a smaller set of files');
  const definition = pkg.definition;
  if (definition.id.length > 64) throw new Error('Component ID exceeds 64 characters.');
  if (definition.real && !['http:', 'https:'].includes(new URL(definition.real.url).protocol)) throw new Error('Real URL must be HTTP(S)');
  const documents = definition.context.map(path => {
    if (!safeDocument(path) || !Object.hasOwn(pkg.documents, path)) throw new Error(`Missing or invalid context document: ${path}`);
    return {path, text: pkg.documents[path]};
  });
  const responses = new Map(Object.entries(definition.operation.responses).map(([status, schema]) => [Number(status), ajv.compile(schema)]));
  return { definition, documents, responses, input: ajv.compile(definition.operation.inputSchema),
    revision: createHash('sha256').update(JSON.stringify({ definition, documents })).digest('hex') };
}
export async function loadComponent(file: string, overrides: Pick<Partial<ComponentDefinition>, 'real'> = {}): Promise<LoadedComponent> {
  const definition: ComponentDefinition = { ...JSON.parse(await readFile(file, 'utf8')), ...overrides };
  if (!validateDefinition(definition)) throw new Error(ajv.errorsText(validateDefinition.errors));
  if (definition.real && !['http:', 'https:'].includes(new URL(definition.real.url).protocol)) throw new Error('Real URL must be HTTP(S)');
  const root = await realpath(dirname(resolve(file)));
  let bytes = 0;
  const documents = [];
  for (const path of definition.context) {
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Context must remain within component directory');
    const text = await readFile(actual, 'utf8');
    bytes += Buffer.byteLength(text);
    if (bytes > 256 * 1024) throw new Error('Context exceeds 256 KiB; select a smaller set of files');
    documents.push({ path, text });
  }
  return loadComponentPackage({definition, documents: Object.fromEntries(documents.map(document => [document.path, document.text]))});
}
