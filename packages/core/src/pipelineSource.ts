import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export const PIPELINE_INPUT_CONTRACT = Object.freeze({
    version: '1',
    authorRoot: 'pipeline',
    approvedBundleRoot: '.leiok/execution-bundles',
    absolutePathPolicy: 'allowed_roots_only',
    regularFileRequired: true,
    redirectedAncestors: 'confined_to_workspace',
    validationExecutionParity: true,
    approvedBundleFilenameSha256: true
});

const APPROVED_PLAN_ID = /^(?!^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$))[A-Za-z0-9](?:[A-Za-z0-9._@+-]{0,254}[A-Za-z0-9_@+-])?$/i;
const APPROVED_BUNDLE_FILE = /^[a-f0-9]{64}\.intent\.json$/;

export class PipelineSourcePathError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'PipelineSourcePathError';
    }
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
}

function unavailable(message: string): never {
    throw new PipelineSourcePathError('PATH_UNAVAILABLE', message);
}

function canonicalExisting(inputPath: string, message: string): string {
    try {
        return fs.realpathSync.native(inputPath);
    } catch {
        return unavailable(message);
    }
}

function canonicalRoot(inputPath: string): string | undefined {
    try {
        return fs.realpathSync.native(inputPath);
    } catch {
        return undefined;
    }
}

function assertApprovedBundleLayout(bundleRoot: string, candidate: string): void {
    const parts = path.relative(bundleRoot, candidate).split(path.sep);
    if (
        parts.length !== 2
        || !APPROVED_PLAN_ID.test(parts[0])
        || !APPROVED_BUNDLE_FILE.test(parts[1])
    ) {
        throw new PipelineSourcePathError(
            'PATH_OUTSIDE_PIPELINE',
            'Approved bundles must match <workspace>/.leiok/execution-bundles/<plan_id>/<sha256>.intent.json.'
        );
    }
}

/**
 * Resolve a top-level executable pipeline source without allowing arbitrary
 * workspace files. Short names retain the historic pipeline/<name>.intent.json
 * behavior; control-plane bundles use their immutable, content-addressed path.
 */
type ResolvedPipelineSource = {
    path: string;
    approvedBundleHash?: string;
};

export type ReadPipelineSource = ResolvedPipelineSource & {
    bytes: Buffer;
    contentHash: string;
};

function resolvePipelineSource(workspace: string, reference: string): ResolvedPipelineSource {
    const root = path.resolve(workspace);
    const raw = String(reference || '').trim();
    if (!raw) throw new PipelineSourcePathError('PIPELINE_REQUIRED', 'A pipeline name or path is required.');
    if (raw.includes('\0')) throw new PipelineSourcePathError('INVALID_PATH', 'Pipeline paths cannot contain NUL.');
    if (process.platform !== 'win32' && path.win32.isAbsolute(raw) && !path.isAbsolute(raw)) {
        throw new PipelineSourcePathError(
            'PATH_OUTSIDE_PIPELINE',
            'A foreign absolute path is outside the allowed pipeline source roots.'
        );
    }

    const normalized = raw.replace(/[\\/]/g, path.sep);
    const withExtension = normalized.endsWith('.intent.json') ? normalized : `${normalized}.intent.json`;
    const pipelineRoot = path.join(root, 'pipeline');
    const bundleRoot = path.join(root, '.leiok', 'execution-bundles');
    const hasDirectory = withExtension.includes(path.sep);
    const candidate = path.isAbsolute(withExtension)
        ? path.resolve(withExtension)
        : path.resolve(hasDirectory ? root : pipelineRoot, withExtension);

    const lexicalSourceRoot = isInside(pipelineRoot, candidate)
        ? pipelineRoot
        : isInside(bundleRoot, candidate)
            ? bundleRoot
            : undefined;
    // Relative references have no legitimate aliasing reason to leave the two
    // lexical roots, so reject traversal before probing any other filesystem path.
    if (!path.isAbsolute(withExtension) && !lexicalSourceRoot) {
        throw new PipelineSourcePathError(
            'PATH_OUTSIDE_PIPELINE',
            'Pipeline files must stay under <workspace>/pipeline or the approved execution-bundle root.'
        );
    }
    if (lexicalSourceRoot === bundleRoot) assertApprovedBundleLayout(bundleRoot, candidate);

    const realRoot = canonicalExisting(root, 'The workspace is unavailable.');
    const realCandidate = canonicalExisting(candidate, 'The pipeline file is unavailable.');
    const roots = [
        { lexical: pipelineRoot, real: canonicalRoot(pipelineRoot), approvedBundle: false },
        { lexical: bundleRoot, real: canonicalRoot(bundleRoot), approvedBundle: true }
    ];
    const selected = roots.find((entry) => {
        if (!entry.real || !isInside(realRoot, entry.real) || !isInside(entry.real, realCandidate)) return false;
        if (entry.approvedBundle) assertApprovedBundleLayout(entry.real, realCandidate);
        return true;
    });
    if (!selected) {
        const lexical = roots.find((entry) => entry.lexical === lexicalSourceRoot);
        if (lexical && !lexical.real) {
            return unavailable('The selected pipeline source root is unavailable.');
        }
        if (lexical?.real && !isInside(realRoot, lexical.real)) {
            throw new PipelineSourcePathError('PATH_OUTSIDE_WORKSPACE', 'The pipeline source root resolves outside the workspace.');
        }
        throw new PipelineSourcePathError('PATH_OUTSIDE_PIPELINE', 'The pipeline file resolves outside its allowed source root.');
    }
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(candidate);
    } catch {
        return unavailable('The pipeline file is unavailable.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PipelineSourcePathError('NOT_A_FILE', 'The pipeline path must identify a regular file.');
    }
    return {
        path: realCandidate,
        ...(selected.approvedBundle
            ? { approvedBundleHash: path.basename(realCandidate, '.intent.json') }
            : {})
    };
}

export function resolvePipelineSourcePath(workspace: string, reference: string): string {
    return resolvePipelineSource(workspace, reference).path;
}

/** Read once, bind approved bundles to their content-addressed filename, and
 * return the exact bytes that the validator or runtime must parse. */
export function readPipelineSource(workspace: string, reference: string): ReadPipelineSource {
    const source = resolvePipelineSource(workspace, reference);
    let bytes: Buffer;
    try {
        bytes = fs.readFileSync(source.path);
    } catch {
        return unavailable('The pipeline file is unavailable.');
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (source.approvedBundleHash && source.approvedBundleHash !== contentHash) {
        throw new PipelineSourcePathError(
            'PIPELINE_HASH_MISMATCH',
            'Approved bundle content does not match its SHA-256 filename.'
        );
    }
    return { ...source, bytes, contentHash };
}
