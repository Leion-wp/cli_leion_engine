import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadTuiConfig } from '../state/config';

function makeWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leion-tui-test-'));
    fs.mkdirSync(path.join(root, '.intent-router'), { recursive: true });
    return root;
}

test('loadTuiConfig uses v2 defaults when config missing', () => {
    const workspace = makeWorkspace();
    const config = loadTuiConfig(workspace);
    assert.equal(config.ui.version, 'v2');
    assert.equal(config.theme.name, 'leion-pro');
    assert.equal(config.theme.highContrast, false);
    assert.equal(config.keymap.profile, 'hybrid');
    assert.equal(config.palette.enabled, true);
    assert.equal(config.palette.trigger, 'ctrl+k');
    assert.equal(config.maxLogs, 2000);
    assert.equal(config.maxEvents, 5000);
});

test('loadTuiConfig reads nested config overrides', () => {
    const workspace = makeWorkspace();
    const file = path.join(workspace, '.intent-router', 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        intentRouter: {
            tui: {
                logs: { maxLines: 111 },
                events: { maxItems: 222 },
                ui: { version: 'legacy' },
                theme: { name: 'leion-pro', highContrast: true },
                keymap: { profile: 'classic' },
                palette: { enabled: false, trigger: 'ctrl+k' }
            }
        }
    }));

    const config = loadTuiConfig(workspace);
    assert.equal(config.maxLogs, 111);
    assert.equal(config.maxEvents, 222);
    assert.equal(config.ui.version, 'legacy');
    assert.equal(config.theme.highContrast, true);
    assert.equal(config.keymap.profile, 'classic');
    assert.equal(config.palette.enabled, false);
});
