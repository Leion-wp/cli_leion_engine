import * as vscode from '../ports/vscodeShim';
import { registerCapabilities } from '../registry';
import { executePolicyCheck, policyCapabilities } from '../policyCapability';

export function registerPolicyProvider(context: vscode.ExtensionContext): void {
    registerCapabilities(policyCapabilities);
    context.subscriptions.push(
        vscode.commands.registerCommand('intentRouter.internal.systemPolicyCheck', async (args: any) => {
            return executePolicyCheck(args);
        })
    );
}
