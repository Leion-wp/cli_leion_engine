import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import chokidar, { FSWatcher } from 'chokidar';

export type Disposable = { dispose: () => void };

function createDisposable(dispose: () => void): Disposable {
    return { dispose };
}

export class EventEmitter<T> {
    private listeners: Array<(event: T) => any> = [];

    readonly event = (listener: (event: T) => any): Disposable => {
        this.listeners.push(listener);
        return createDisposable(() => {
            this.listeners = this.listeners.filter((entry) => entry !== listener);
        });
    };

    fire(event: T): void {
        const snapshot = [...this.listeners];
        for (const listener of snapshot) {
            try {
                listener(event);
            } catch {
                // Best effort emitter.
            }
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

export class Uri {
    readonly fsPath: string;
    readonly path: string;
    readonly scheme: string;

    private constructor(fsPath: string, uriPath: string, scheme: string) {
        this.fsPath = fsPath;
        this.path = uriPath;
        this.scheme = scheme;
    }

    static file(inputPath: string): Uri {
        const resolved = path.resolve(String(inputPath || ''));
        const normalizedPath = resolved.replace(/\\/g, '/');
        return new Uri(resolved, normalizedPath, 'file');
    }

    static parse(rawValue: string): Uri {
        const raw = String(rawValue || '').trim();
        if (!raw) {
            return Uri.file(process.cwd());
        }
        const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
        if (!schemeMatch || schemeMatch[1].toLowerCase() === 'file') {
            return Uri.file(raw.replace(/^file:\/\//i, ''));
        }
        return new Uri(raw, raw, schemeMatch[1].toLowerCase());
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
        if (base.scheme !== 'file') {
            const suffix = parts.map((entry) => String(entry || '')).filter(Boolean).join('/');
            const combined = suffix ? `${base.path.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}` : base.path;
            return new Uri(combined, combined, base.scheme);
        }
        return Uri.file(path.join(base.fsPath, ...parts));
    }

    with(changes: { path?: string | null }): Uri {
        if (this.scheme !== 'file') {
            const nextPath = typeof changes?.path === 'string' ? changes.path : this.path;
            return new Uri(nextPath, nextPath, this.scheme);
        }
        const nextPath = typeof changes?.path === 'string' ? changes.path : this.path;
        return Uri.file(nextPath);
    }

    toString(): string {
        if (this.scheme === 'file') {
            return this.path;
        }
        return `${this.scheme}:${this.path}`;
    }
}

export type WorkspaceFolder = {
    uri: Uri;
    name?: string;
    index?: number;
};

export type OutputChannel = {
    appendLine: (text: string) => void;
    clear: () => void;
};

export type TerminalOptions = {
    name?: string;
    env?: Record<string, string>;
    pty?: Pseudoterminal;
};

export type Terminal = {
    name: string;
    creationOptions: TerminalOptions;
    show: (preserveFocus?: boolean) => void;
    sendText: (text: string) => void;
    dispose: () => void;
};

export type Pseudoterminal = {
    onDidWrite?: (listener: (data: string) => any) => Disposable;
    open?: () => void;
    close?: () => void;
};

export type WorkspaceConfiguration = {
    get: <T>(key: string, defaultValue?: T) => T;
    update: (key: string, value: any) => Promise<void>;
};

export type ConfigurationChangeEvent = {
    affectsConfiguration: (section: string) => boolean;
};

export type FileSystemWatcher = {
    onDidCreate: (listener: (uri: Uri) => any) => Disposable;
    onDidChange: (listener: (uri: Uri) => any) => Disposable;
    onDidDelete: (listener: (uri: Uri) => any) => Disposable;
    dispose: () => void;
};

export type ExtensionContext = {
    subscriptions: Disposable[];
};

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
};

export const ViewColumn = {
    Active: 1
};

export const ExtensionMode = {
    Development: 1,
    Test: 2,
    Production: 3
};

export type CoreHostPorts = {
    workspaceRoot?: string;
    workspace?: {
        rootPath?: string;
    };
    fs?: {
        readFile?: (filePath: string) => Promise<Uint8Array> | Uint8Array;
        writeFile?: (filePath: string, content: Uint8Array) => Promise<void> | void;
    };
    config?: {
        get: (fullKey: string, defaultValue?: any) => any;
        set?: (fullKey: string, value: any) => void;
    };
    interaction?: {
        showInputBox?: (options: any) => Promise<string | undefined>;
        showQuickPick?: (items: any[], options: any) => Promise<any>;
        showInformationMessage?: (message: string, options?: any, ...items: any[]) => Promise<any>;
        showWarningMessage?: (message: string, options?: any, ...items: any[]) => Promise<any>;
        showErrorMessage?: (message: string, options?: any, ...items: any[]) => Promise<any>;
    };
    event_sink?: {
        log?: (channel: string, line: string) => void;
        info?: (message: string) => void;
        warn?: (message: string) => void;
        error?: (message: string) => void;
    };
    command_dispatch?: {
        executeCommand?: (id: string, ...args: any[]) => Promise<any>;
    };
    process_control?: {
        run?: (command: string, options?: any) => Promise<any>;
        stop?: (runId: string) => Promise<void> | void;
    };
};

const commandHandlers = new Map<string, (...args: any[]) => any>();
const outputBuffers = new Map<string, string[]>();
const configurationChangeEmitter = new EventEmitter<ConfigurationChangeEvent>();
const clipboardStore = { text: '' };
const activeWatchers = new Set<FSWatcher>();
const terminals: Terminal[] = [];

let hostPorts: CoreHostPorts = {
    workspaceRoot: process.cwd()
};

const configStore = new Map<string, any>();

export function setHostPorts(nextPorts: CoreHostPorts): void {
    hostPorts = {
        ...hostPorts,
        ...nextPorts
    };
    if (nextPorts.workspaceRoot) {
        workspace.workspaceFolders = [{ uri: Uri.file(nextPorts.workspaceRoot), name: path.basename(nextPorts.workspaceRoot), index: 0 }];
    }
}

export function resetHostPorts(): void {
    for (const watcher of activeWatchers) {
        try {
            watcher.close();
        } catch {
            // ignore
        }
    }
    activeWatchers.clear();
    commandHandlers.clear();
    outputBuffers.clear();
    terminals.length = 0;
    hostPorts = { workspaceRoot: process.cwd() };
    workspace.workspaceFolders = [{ uri: Uri.file(process.cwd()), name: path.basename(process.cwd()), index: 0 }];
}

export function setConfigEntries(entries: Record<string, any>): void {
    for (const [key, value] of Object.entries(entries || {})) {
        configStore.set(String(key), value);
    }
}

function readConfigValue(fullKey: string, defaultValue: any): any {
    if (hostPorts.config?.get) {
        return hostPorts.config.get(fullKey, defaultValue);
    }
    if (configStore.has(fullKey)) {
        return configStore.get(fullKey);
    }
    return defaultValue;
}

function writeConfigValue(fullKey: string, value: any): void {
    if (hostPorts.config?.set) {
        hostPorts.config.set(fullKey, value);
        return;
    }
    configStore.set(fullKey, value);
}

function emitConfigChange(changedKey: string): void {
    const normalized = String(changedKey || '').trim();
    configurationChangeEmitter.fire({
        affectsConfiguration: (candidate: string) => {
            const entry = String(candidate || '').trim();
            if (!entry) return false;
            return normalized === entry || normalized.startsWith(`${entry}.`);
        }
    });
}

function getWorkspaceRoot(): string {
    const fromWorkspacePort = String(hostPorts.workspace?.rootPath || '').trim();
    if (fromWorkspacePort) {
        return path.resolve(fromWorkspacePort);
    }
    const fromHost = String(hostPorts.workspaceRoot || '').trim();
    if (fromHost) {
        return path.resolve(fromHost);
    }
    const folder = workspace.workspaceFolders?.[0];
    if (folder?.uri?.fsPath) {
        return folder.uri.fsPath;
    }
    return process.cwd();
}

async function safeStat(fsPath: string): Promise<fs.Stats> {
    return await fsp.stat(fsPath);
}

export const workspace = {
    workspaceFolders: [{ uri: Uri.file(process.cwd()), name: path.basename(process.cwd()), index: 0 }] as WorkspaceFolder[],

    getConfiguration: (section?: string): WorkspaceConfiguration => {
        return {
            get: <T>(key: string, defaultValue?: T): T => {
                const fullKey = section ? `${section}.${key}` : key;
                return readConfigValue(fullKey, defaultValue) as T;
            },
            update: async (key: string, value: any): Promise<void> => {
                const fullKey = section ? `${section}.${key}` : key;
                writeConfigValue(fullKey, value);
                emitConfigChange(fullKey);
            }
        };
    },

    onDidChangeConfiguration: (listener: (event: ConfigurationChangeEvent) => any): Disposable => {
        return configurationChangeEmitter.event(listener);
    },

    findFiles: async (pattern: string): Promise<Uri[]> => {
        const cwd = getWorkspaceRoot();
        const matches = await glob(String(pattern || ''), {
            cwd,
            nodir: true,
            absolute: true
        });
        return matches.map((entry) => Uri.file(entry));
    },

    createFileSystemWatcher: (globPattern: string): FileSystemWatcher => {
        const root = getWorkspaceRoot();
        const createEmitter = new EventEmitter<Uri>();
        const changeEmitter = new EventEmitter<Uri>();
        const deleteEmitter = new EventEmitter<Uri>();

        const watcher = chokidar.watch(String(globPattern || ''), {
            cwd: root,
            ignoreInitial: true,
            persistent: true
        });
        activeWatchers.add(watcher);

        const toUri = (filePath: string): Uri => {
            const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
            return Uri.file(absolute);
        };

        watcher.on('add', (filePath) => createEmitter.fire(toUri(filePath)));
        watcher.on('change', (filePath) => changeEmitter.fire(toUri(filePath)));
        watcher.on('unlink', (filePath) => deleteEmitter.fire(toUri(filePath)));

        return {
            onDidCreate: (listener: (uri: Uri) => any) => createEmitter.event(listener),
            onDidChange: (listener: (uri: Uri) => any) => changeEmitter.event(listener),
            onDidDelete: (listener: (uri: Uri) => any) => deleteEmitter.event(listener),
            dispose: () => {
                createEmitter.dispose();
                changeEmitter.dispose();
                deleteEmitter.dispose();
                activeWatchers.delete(watcher);
                void watcher.close();
            }
        };
    },

    fs: {
        createDirectory: async (uri: Uri): Promise<void> => {
            await fsp.mkdir(uri.fsPath, { recursive: true });
        },
        writeFile: async (uri: Uri, data: Uint8Array): Promise<void> => {
            await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fsp.writeFile(uri.fsPath, Buffer.from(data));
        },
        readFile: async (uri: Uri): Promise<Uint8Array> => {
            const content = await fsp.readFile(uri.fsPath);
            return new Uint8Array(content);
        },
        stat: async (uri: Uri): Promise<{ size: number; ctime: number; mtime: number; type: number }> => {
            const stats = await safeStat(uri.fsPath);
            return {
                size: stats.size,
                ctime: stats.ctimeMs,
                mtime: stats.mtimeMs,
                type: stats.isDirectory() ? 2 : 1
            };
        },
        delete: async (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> => {
            await fsp.rm(uri.fsPath, { recursive: options?.recursive === true, force: true });
        },
        rename: async (source: Uri, target: Uri): Promise<void> => {
            await fsp.mkdir(path.dirname(target.fsPath), { recursive: true });
            await fsp.rename(source.fsPath, target.fsPath);
        }
    }
};

export const window = {
    terminals,
    activeTextEditor: undefined as any,

    createOutputChannel: (name: string): OutputChannel => {
        const key = String(name || 'output');
        if (!outputBuffers.has(key)) {
            outputBuffers.set(key, []);
        }
        return {
            appendLine: (text: string) => {
                const line = String(text || '');
                outputBuffers.get(key)!.push(line);
                hostPorts.event_sink?.log?.(key, line);
            },
            clear: () => {
                outputBuffers.set(key, []);
            }
        };
    },

    showInputBox: async (options: any): Promise<string | undefined> => {
        if (hostPorts.interaction?.showInputBox) {
            return await hostPorts.interaction.showInputBox(options);
        }
        return undefined;
    },

    showQuickPick: async (items: any[], options: any): Promise<any> => {
        if (hostPorts.interaction?.showQuickPick) {
            return await hostPorts.interaction.showQuickPick(items, options);
        }
        return undefined;
    },

    showInformationMessage: async (message: string, options?: any, ...items: any[]): Promise<any> => {
        if (hostPorts.interaction?.showInformationMessage) {
            return await hostPorts.interaction.showInformationMessage(message, options, ...items);
        }
        hostPorts.event_sink?.info?.(String(message || ''));
        return undefined;
    },

    showWarningMessage: async (message: string, options?: any, ...items: any[]): Promise<any> => {
        if (hostPorts.interaction?.showWarningMessage) {
            return await hostPorts.interaction.showWarningMessage(message, options, ...items);
        }
        hostPorts.event_sink?.warn?.(String(message || ''));
        return undefined;
    },

    showErrorMessage: async (message: string, options?: any, ...items: any[]): Promise<any> => {
        if (hostPorts.interaction?.showErrorMessage) {
            return await hostPorts.interaction.showErrorMessage(message, options, ...items);
        }
        hostPorts.event_sink?.error?.(String(message || ''));
        return undefined;
    },

    createTerminal: (nameOrOptions: string | TerminalOptions): Terminal => {
        const options = typeof nameOrOptions === 'string'
            ? { name: nameOrOptions }
            : (nameOrOptions || {});
        const terminal: Terminal = {
            name: String(options.name || 'Terminal'),
            creationOptions: options,
            show: () => {
                // no-op
            },
            sendText: (_text: string) => {
                // no-op for shim terminal transport.
            },
            dispose: () => {
                const index = terminals.indexOf(terminal);
                if (index !== -1) {
                    terminals.splice(index, 1);
                }
            }
        };
        terminals.push(terminal);
        return terminal;
    }
};

export const commands = {
    registerCommand: (id: string, handler: (...args: any[]) => any): Disposable => {
        const key = String(id || '').trim();
        commandHandlers.set(key, handler);
        return createDisposable(() => {
            commandHandlers.delete(key);
        });
    },

    executeCommand: async (id: string, ...args: any[]): Promise<any> => {
        const key = String(id || '').trim();
        const local = commandHandlers.get(key);
        if (local) {
            return await local(...args);
        }
        if (hostPorts.command_dispatch?.executeCommand) {
            return await hostPorts.command_dispatch.executeCommand(key, ...args);
        }
        throw new Error(`Command not found: ${key}`);
    },

    getCommands: async (_filterInternal?: boolean): Promise<string[]> => {
        return Array.from(commandHandlers.keys()).sort();
    }
};

export const env = {
    clipboard: {
        writeText: async (text: string): Promise<void> => {
            clipboardStore.text = String(text || '');
        },
        readText: async (): Promise<string> => {
            return clipboardStore.text;
        }
    },
    openExternal: async (_uri: Uri): Promise<boolean> => {
        return true;
    }
};

export const __mock = {
    commandHandlers,
    outputBuffers,
    configStore,
    resetHostPorts,
    setHostPorts,
    setConfigEntries
};
