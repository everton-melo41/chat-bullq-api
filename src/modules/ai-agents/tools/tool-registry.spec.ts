import { ToolRegistry } from './tool-registry.service';

function registry() {
  const registry = Object.create(ToolRegistry.prototype) as ToolRegistry;
  Object.assign(registry, {
    tools: new Map(['reply', 'clientOps', 'workerOnly'].map(name => [name, { name, description: name, parameters: {} }])),
    scope: new Map([['reply', new Set(['WORKER', 'ORCHESTRATOR'])], ['clientOps', new Set(['WORKER'])], ['workerOnly', new Set(['WORKER'])]]),
    agentAllowlist: new Map([['clientOps', new Set(['allowed'])]]),
  });
  return registry;
}

describe('enabled built-in actions', () => {
  it('null preserves kind and agent restrictions; empty list disables all', () => {
    const r = registry();
    expect(r.getLlmDefinitionsForKind('WORKER', 'other', null).map(t => t.name)).toEqual(['reply', 'workerOnly']);
    expect(r.getLlmDefinitionsForKind('WORKER', 'allowed', [])).toEqual([]);
    expect(r.isAllowedForAgent('reply', 'WORKER', 'allowed', [])).toBe(false);
  });
  it('applies same filter to definitions and dispatch without bypassing allowlists', () => {
    const r = registry();
    expect(r.getLlmDefinitionsForKind('WORKER', 'other', ['reply', 'clientOps']).map(t => t.name)).toEqual(['reply']);
    expect(r.isAllowedForAgent('clientOps', 'WORKER', 'other', ['clientOps'])).toBe(false);
    expect(r.isAllowedForAgent('workerOnly', 'ORCHESTRATOR', 'allowed', ['workerOnly'])).toBe(false);
    expect(r.isAllowedForAgent('reply', 'WORKER', 'other', ['reply'])).toBe(true);
  });
});
