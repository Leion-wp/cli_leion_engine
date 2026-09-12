import { dockerCapabilities } from '../builtinCapabilities';
import * as vscode from '../ports/vscodeShim';
import { registerCapabilities } from '../registry';

export function registerDockerProvider(context: vscode.ExtensionContext) {
    // V2 direction: Docker steps compile to terminal commands in the runner.
    // We still register schemas/templates for the builder and keep VS Code commands as a fallback for direct routing.
    doRegister();
}

function doRegister() {
    registerCapabilities(dockerCapabilities);
    console.error('[Intent Router] Registered Docker provider capabilities.');
}

export const dockerTemplates: Record<string, any> = {
    'docker.build': { "tag": "myapp:latest", "path": "." },
    'docker.run': { "image": "myapp:latest", "detach": true }
};
