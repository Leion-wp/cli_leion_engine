const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shim = require('../packages/core/out/ports/vscodeShim');
const registry = require('../packages/core/out/registry');
const { pipelineEventBus } = require('../packages/core/out/eventBus');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leion-runtime-p0-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^leion-runtime-p0-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fixture(t) {
  const root = workspace(t);
  shim.resetHostPorts();
  shim.setHostPorts({ workspaceRoot: root });
  // The router caches its channel; resetHostPorts clears the backing buffers.
  shim.window.createOutputChannel('Intent Router');
  shim.setConfigEntries({ 'intentRouter.runtime.sandbox.timeoutMs': 25 });
  registry.resetRegistry();
  const events = [];
  const subscription = pipelineEventBus.on((event) => events.push(event));
  t.after(() => subscription.dispose());
  const invocations = [];
  const mappings = [];
  registry.registerCapabilities({
    provider: 'sentinel',
    type: 'vscode',
    capabilities: [
      'terminal.run', 'http.request', 'ai.generate', 'github.openPr',
      'system.pause', 'system.subPipeline', 'system.loop', 'system.form',
      'system.setVar', 'memory.save', 'memory.recall', 'memory.clear'
    ].map((capability) => ({
      capability,
      command: `sentinel.${capability}`,
      mapPayload: (intent) => { mappings.push(capability); return intent.payload; }
    }))
  });
  t.mock.method(shim.commands, 'executeCommand', async (id, ...args) => {
    invocations.push({ id, args });
    return true;
  });
  return { root, events, invocations, mappings };
}

function step(id, intent, payload = {}, rest = {}) {
  return { id, intent, payload, ...rest };
}

module.exports = { workspace, fixture, step, shim, registry };
