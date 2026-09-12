import { gitCapabilities } from '../builtinCapabilities';
import * as vscode from '../ports/vscodeShim';
import { registerCapabilities } from '../registry';

export function registerGitProvider(context: vscode.ExtensionContext) {
    // V2 direction: Git steps compile to terminal commands in the runner.
    // We still register schemas/templates for the builder and keep VS Code commands as a fallback for direct routing.
    doRegister();
}

function doRegister() {
    registerCapabilities(gitCapabilities);
    console.error('[Intent Router] Registered Git provider capabilities.');
}

export const gitTemplates: Record<string, any> = {
    'git.clone': { "url": "https://github.com/org/repo.git", "dir": "." },
    'git.commit': { "message": "chore: update", "amend": false },
    'git.push': {},
    'git.pull': {},
    'git.checkout': { "branch": "main", "create": false }
};
