import { RegisterCapabilitiesArgs } from './types';

export type PolicyRule = {
    kind: 'equals' | 'regex' | 'min_length';
    path?: string;
    value?: any;
    pattern?: string;
    message?: string;
};

export type PolicyCheckResult = {
    passed: boolean;
    mode: 'block' | 'warn';
    violations: Array<{
        index: number;
        kind: PolicyRule['kind'];
        path: string;
        message: string;
    }>;
};

export const policyCapabilities: RegisterCapabilitiesArgs = {
    provider: 'system',
    type: 'vscode',
    capabilities: [
        {
            capability: 'system.policy.check',
            command: 'intentRouter.internal.systemPolicyCheck',
            description: 'Evaluate deterministic fail-closed policy rules against structured data',
            determinism: 'deterministic',
            args: [
                { name: 'subject', type: 'string', description: 'JSON value or structured subject to validate', required: true },
                { name: 'rules', type: 'string', description: 'Ordered policy rule array', required: true },
                { name: 'mode', type: 'enum', options: ['block', 'warn'], description: 'Block on violations or return warnings', default: 'block' }
            ]
        }
    ]
};

const forbiddenPathSegments = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeSubject(subject: any): any {
    if (typeof subject !== 'string') return subject;
    const trimmed = subject.trim();
    if (!trimmed) return subject;
    try {
        return JSON.parse(trimmed);
    } catch {
        return subject;
    }
}

function resolvePath(subject: any, path: string): { found: boolean; value?: any } {
    const normalizedPath = String(path ?? '').trim();
    if (!normalizedPath) return { found: true, value: subject };
    const segments = normalizedPath.split('.');
    let current = subject;
    for (const segment of segments) {
        if (!segment || forbiddenPathSegments.has(segment)) return { found: false };
        if (current === null || (typeof current !== 'object' && !Array.isArray(current))) return { found: false };
        if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
        current = current[segment];
    }
    return { found: true, value: current };
}

function deepEqual(left: any, right: any): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left)) {
        if (left.length !== right.length) return false;
        return left.every((entry, index) => deepEqual(entry, right[index]));
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function violation(rule: PolicyRule, index: number, fallback: string) {
    return {
        index,
        kind: rule.kind,
        path: String(rule.path ?? ''),
        message: String(rule.message || fallback)
    };
}

export function evaluatePolicyCheck(args: any): PolicyCheckResult {
    const mode = String(args?.mode || 'block').trim().toLowerCase();
    if (mode !== 'block' && mode !== 'warn') {
        throw new Error(`POLICY_INVALID: unsupported mode "${mode}"`);
    }
    if (!Array.isArray(args?.rules) || args.rules.length === 0) {
        throw new Error('POLICY_INVALID: rules must be a non-empty array');
    }

    const subject = normalizeSubject(args.subject);
    const violations: PolicyCheckResult['violations'] = [];

    args.rules.forEach((rawRule: any, index: number) => {
        if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
            throw new Error(`POLICY_INVALID: rule ${index} must be an object`);
        }
        const rule = rawRule as PolicyRule;
        if (!['equals', 'regex', 'min_length'].includes(String(rule.kind))) {
            throw new Error(`POLICY_INVALID: unsupported rule kind "${String(rule.kind)}" at index ${index}`);
        }
        const resolved = resolvePath(subject, String(rule.path ?? ''));
        if (!resolved.found) {
            violations.push(violation(rule, index, `Missing policy path: ${String(rule.path ?? '') || '<root>'}`));
            return;
        }

        if (rule.kind === 'equals') {
            if (!Object.prototype.hasOwnProperty.call(rule, 'value')) {
                throw new Error(`POLICY_INVALID: equals rule ${index} requires value`);
            }
            if (!deepEqual(resolved.value, rule.value)) {
                violations.push(violation(rule, index, `Expected ${String(rule.path ?? '') || '<root>'} to equal ${JSON.stringify(rule.value)}`));
            }
            return;
        }

        if (rule.kind === 'regex') {
            if (typeof rule.pattern !== 'string' || rule.pattern.length === 0 || rule.pattern.length > 512) {
                throw new Error(`POLICY_INVALID: regex rule ${index} requires a pattern of 1..512 characters`);
            }
            let matcher: RegExp;
            try {
                matcher = new RegExp(rule.pattern);
            } catch (error: any) {
                throw new Error(`POLICY_INVALID: regex rule ${index} has invalid pattern: ${String(error?.message || error)}`);
            }
            if (typeof resolved.value !== 'string' || !matcher.test(resolved.value)) {
                violations.push(violation(rule, index, `Value at ${String(rule.path ?? '') || '<root>'} does not match required pattern`));
            }
            return;
        }

        const minimum = Number(rule.value);
        if (!Number.isInteger(minimum) || minimum < 0) {
            throw new Error(`POLICY_INVALID: min_length rule ${index} requires a non-negative integer value`);
        }
        const value = resolved.value;
        if ((typeof value !== 'string' && !Array.isArray(value)) || value.length < minimum) {
            violations.push(violation(rule, index, `Value at ${String(rule.path ?? '') || '<root>'} must have length >= ${minimum}`));
        }
    });

    return {
        passed: violations.length === 0,
        mode: mode as 'block' | 'warn',
        violations
    };
}

export function executePolicyCheck(args: any): { content: string; changes: never[] } {
    const result = evaluatePolicyCheck(args);
    if (!result.passed && result.mode === 'block') {
        const details = result.violations.map((entry) => entry.message).join('; ');
        throw new Error(`POLICY_BLOCKED: ${details}`);
    }
    return { content: JSON.stringify(result), changes: [] };
}
