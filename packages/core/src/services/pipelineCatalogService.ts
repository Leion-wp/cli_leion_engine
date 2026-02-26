import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

export type PipelineRef = {
    name: string;
    path: string;
    relPath: string;
    updatedAt: number;
    size: number;
};

export class PipelineCatalogService {
    constructor(private readonly workspaceRoot: string) {}

    resolvePipelinePath(pipelineRef: string): string {
        const raw = String(pipelineRef || '').trim();
        if (!raw) {
            throw new Error('Pipeline reference is required.');
        }
        const withExt = raw.endsWith('.intent.json') ? raw : `${raw}.intent.json`;
        if (path.isAbsolute(withExt)) {
            return path.resolve(withExt);
        }
        const hasDirectory = withExt.includes('/') || withExt.includes('\\');
        if (hasDirectory) {
            return path.resolve(this.workspaceRoot, withExt);
        }
        return path.resolve(this.workspaceRoot, 'pipeline', withExt);
    }

    list(): PipelineRef[] {
        const files = globSync('pipeline/**/*.intent.json', {
            cwd: this.workspaceRoot,
            absolute: true,
            nodir: true
        });
        return files
            .map((entry) => {
                const stat = fs.statSync(entry);
                const rel = path.relative(this.workspaceRoot, entry).replace(/\\/g, '/');
                const base = path.basename(entry).replace(/\.intent\.json$/i, '');
                return {
                    name: base,
                    path: path.resolve(entry),
                    relPath: rel,
                    updatedAt: Number(stat.mtimeMs || 0),
                    size: Number(stat.size || 0)
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    load<T = any>(pipelineRef: string): T {
        const filePath = this.resolvePipelinePath(pipelineRef);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Pipeline not found: ${filePath}`);
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }

    save(pipelineRef: string, pipeline: any): { path: string; pipeline: any } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        if (!pipeline || typeof pipeline !== 'object' || !Array.isArray((pipeline as any).steps)) {
            throw new Error('Invalid pipeline payload: expected object with steps array.');
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
        return { path: filePath, pipeline };
    }

    create(name: string, description?: string): { path: string; pipeline: any } {
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            throw new Error('Pipeline name is required.');
        }
        const filePath = this.resolvePipelinePath(trimmed);
        if (fs.existsSync(filePath)) {
            throw new Error(`Pipeline already exists: ${filePath}`);
        }
        const pipeline = {
            name: trimmed.replace(/\.intent\.json$/i, ''),
            ...(String(description || '').trim() ? { description: String(description).trim() } : {}),
            steps: [] as any[]
        };
        return this.save(trimmed, pipeline);
    }

    delete(pipelineRef: string): { path: string } {
        const filePath = this.resolvePipelinePath(pipelineRef);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Pipeline not found: ${filePath}`);
        }
        fs.unlinkSync(filePath);
        return { path: filePath };
    }
}

