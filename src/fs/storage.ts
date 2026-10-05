import {
    readFile, realpath, open, unlink, rename, stat, mkdtemp, chmod, rmdir
} from 'node:fs/promises';
import {
    dirname, isAbsolute, join, resolve, win32
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HostmanError, sha256 } from '#hostman/domain/model';
import { transform, type Operation } from '#hostman/domain/operations';
export function sourcePath(
    custom?: string,
    platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    cwd = process.cwd()
): string {
    if (custom) {
        return resolve(cwd,
            custom);
    }
    if (platform === 'win32') {
        if (!env.SystemRoot) {
            throw new HostmanError('SystemRoot is missing. Specify --hosts-file <path>.');
        }
        return win32.join(env.SystemRoot,
            'System32',
            'drivers',
            'etc',
            'hosts');
    }
    return '/etc/hosts';
}
export function decode(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8',
            {
                fatal: true,
                ignoreBOM: true
            }).decode(bytes);
    } catch {
        throw new HostmanError('Unsupported hosts encoding. Use ASCII or UTF-8.');
    }
}
export async function readSource(path: string): Promise<{
    path: string;
    text: string;
    digest: string;
}> {
    const destination = await realpath(path), bytes = await readFile(destination);
    const text = decode(bytes);
    if (text.includes('\0')) {
        throw new HostmanError('Unsupported hosts encoding. Use ASCII or UTF-8.');
    }
    return {
        path: destination,
        text,
        digest: sha256(bytes)
    };
}
export type CommitRequest = {
    version: 1;
    sourcePath: string;
    sourceDigest: string;
    operation: Operation;
    resultDigest: string;
};
export type WriterOptions = {
    replace?: (temporary: string, destination: string) => Promise<void>;
    beforeCommit?: () => Promise<void>;
};
export function run(
    executable: string,
    args: string[],
    inherit = false,
    env: NodeJS.ProcessEnv = process.env
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable,
            args,
            {
                shell: false,
                env,
                windowsHide: true,
                stdio: inherit ? 'inherit' : [
                    'ignore',
                    'pipe',
                    'pipe'
                ]
            });
        let output = '', errors = '';
        child.stdout?.on('data',
            value => output += value);
        child.stderr?.on('data',
            value => errors += value);
        child.once('error',
            reject);
        child.once('close',
            code => {
                if (code === 0) {
                    resolve(output.trim());
                    return;
                }
                const message = errors.trim() || `Helper failed or elevation was cancelled (exit ${code}).`;
                const error = new HostmanError(message) as HostmanError & {
                    code?: string;
                };
                if (errors.includes('HOSTMAN_PERMISSION:')) {
                    error.code = 'EACCES';
                }
                reject(error);
            });
    });
}
const windowsScript = fileURLToPath(new URL('./windows.ps1',
    import.meta.url));
function powershellPath(): string {
    if (!process.env.SystemRoot) {
        throw new HostmanError('SystemRoot is missing; Windows elevation helper is unavailable.');
    }
    return win32.join(process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe');
}
async function windows(args: string[]): Promise<string> {
    const env = {
        ...process.env,
        PSModulePath: win32.join(process.env.SystemRoot!,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'Modules')
    };
    return run(powershellPath(),
        [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            windowsScript,
            ...args
        ],
        false,
        env);
}
async function replaceFile(temporary: string, destination: string): Promise<void> {
    if (process.platform === 'win32') {
        await windows([
            '-Mode',
            'Replace',
            '-SourcePath',
            temporary,
            '-DestinationPath',
            destination
        ]);
    } else {
        await rename(temporary,
            destination);
    }
}
export async function commit(request: CommitRequest, options: WriterOptions = {}): Promise<boolean> {
    checkRequest(request);
    const source = await readSource(request.sourcePath);
    if (source.path !== request.sourcePath) {
        throw new HostmanError('Source destination changed. Reload and retry.');
    }
    if (source.digest !== request.sourceDigest) {
        throw new HostmanError('Hosts file changed during operation. Reload and retry.');
    }
    const next = transform(source.text,
        request.operation);
    if (sha256(next) !== request.resultDigest) {
        throw new HostmanError('Operation result differs from the approved preview.');
    }
    if (next === source.text) {
        return false;
    }
    const lock = `${request.sourcePath}.hostman.lock`, temporary = join(dirname(request.sourcePath),
        `.hostman-${randomUUID()}.tmp`);
    let lockHandle;
    try {
        lockHandle = await open(lock,
            'wx',
            0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new HostmanError(`Another hostman writer holds ${lock}. Retry later; `
                + 'remove a stale lock only after checking no writer is running.');
        }
        throw error;
    }
    try {
        const current = await readSource(request.sourcePath);
        if (current.digest !== request.sourceDigest) {
            throw new HostmanError('Hosts file changed during operation. Reload and retry.');
        }
        const metadata = await stat(request.sourcePath);
        const handle = await open(temporary,
            'wx',
            0o600);
        try {
            await handle.writeFile(next,
                'utf8');
            if (process.platform !== 'win32') {
                await handle.chown(metadata.uid,
                    metadata.gid);
                await handle.chmod(metadata.mode & 0o7777);
            }
            await handle.sync();
        } finally {
            await handle.close();
        }
        await options.beforeCommit?.();
        const final = await readSource(request.sourcePath);
        if (final.digest !== request.sourceDigest || final.path !== request.sourcePath) {
            throw new HostmanError('Hosts file changed during operation. Reload and retry.');
        }
        await (options.replace ?? replaceFile)(temporary,
            request.sourcePath);
        return true;
    } finally {
        await unlink(temporary).catch(() => { });
        await lockHandle.close();
        await unlink(lock);
    }
}
function checkRequest(request: CommitRequest): void {
    const kinds = [
        'init',
        'migrate',
        'add-group',
        'remove-group',
        'enable',
        'disable',
        'add-host',
        'remove-host',
        'use',
        'target-add',
        'target-set',
        'target-remove',
        'global-add',
        'global-set',
        'global-remove',
        'repair'
    ];
    if (!request || request.version !== 1
        || typeof request.sourcePath !== 'string' || !isAbsolute(request.sourcePath)
        || !/^[a-f0-9]{64}$/.test(request.sourceDigest) || !/^[a-f0-9]{64}$/.test(request.resultDigest)
        || !request.operation || !kinds.includes(request.operation.kind)) {
        throw new HostmanError('Invalid commit request.');
    }
}
export type ElevationOptions = {
    interactive: boolean;
    allowElevation: boolean;
    isElevated?: () => Promise<boolean>;
    launch?: (requestPath: string, requestHash: string) => Promise<void>;
    writer?: (request: CommitRequest) => Promise<boolean>;
    notify?: (message: string) => void;
};
async function isElevated(): Promise<boolean> {
    return process.platform === 'win32' ? await windows(['-Mode', 'IsAdmin']) === 'true' : process.getuid?.() === 0;
}
async function launch(requestPath: string, requestHash: string): Promise<void> {
    const helper = fileURLToPath(new URL('./helper.js',
        import.meta.url));
    if (process.platform === 'win32') {
        await windows([
            '-Mode',
            'Elevate',
            '-NodePath',
            process.execPath,
            '-HelperPath',
            helper,
            '-RequestPath',
            requestPath,
            '-RequestHash',
            requestHash
        ]);
    } else {
        await run('/usr/bin/sudo',
            [
                process.execPath,
                helper,
                '--commit-request',
                requestPath,
                requestHash
            ],
            true);
    }
}
export async function execute(request: CommitRequest, options: ElevationOptions): Promise<boolean> {
    try {
        return await (options.writer ?? commit)(request);
    } catch (error) {
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
        }
        if (await (options.isElevated ?? isElevated)()) {
            throw new HostmanError(`Write denied despite elevated privileges: ${(error as Error).message}`);
        }
        if (!options.interactive || !options.allowElevation) {
            throw new HostmanError('Writing hosts requires additional permissions. '
                + 'Rerun in an Administrator terminal on Windows, '
                + 'or use sudo with the absolute Node and hostman entry paths on Unix.');
        }
    }
    options.notify?.('Writing hosts requires administrator privileges. Requesting elevation for the commit helper.');
    // A public temporary location allows a different administrator account to read the request.
    const { tmpdir } = await import('node:os');
    const requestDirectory = await mkdtemp(join(tmpdir(),
        'hostman-request-'));
    if (process.platform !== 'win32') {
        await chmod(requestDirectory,
            0o755);
    }
    const requestPath = join(requestDirectory,
            'request.json'), responsePath = `${requestPath}.result`;
    const bytes = JSON.stringify(request);
    try {
        const file = await open(requestPath,
            'wx',
            0o644);
        try {
            await file.writeFile(bytes);
        } finally {
            await file.close();
        }
        let launchError: Error | undefined;
        try {
            await (options.launch ?? launch)(requestPath,
                sha256(bytes));
        } catch (error) {
            launchError = error instanceof Error ? error : new HostmanError(String(error));
        }
        let response: {
            ok: boolean;
            changed?: boolean;
            error?: string;
        };
        try {
            const result: unknown = JSON.parse(await readFile(responsePath,
                'utf8'));
            if (typeof result !== 'object' || result === null || !('ok' in result)
                || typeof result.ok !== 'boolean'
                || ('changed' in result && typeof result.changed !== 'boolean')
                || ('error' in result && typeof result.error !== 'string')) {
                throw new HostmanError('Invalid elevated helper response.');
            }
            response = {
                ok: result.ok,
                changed: 'changed' in result && typeof result.changed === 'boolean' ? result.changed : undefined,
                error: 'error' in result && typeof result.error === 'string' ? result.error : undefined,
            };
        } catch (error) {
            throw launchError ?? error;
        }
        if (!response.ok) {
            throw new HostmanError(response.error ?? 'Elevated commit failed.');
        }
        if (launchError) {
            throw launchError;
        }
        const after = await readSource(request.sourcePath);
        if (after.digest !== request.resultDigest) {
            throw new HostmanError('Hosts changed after the helper completed. Inspect the current file.');
        }
        return response.changed === true;
    } finally {
        await unlink(requestPath).catch(() => { });
        await unlink(responsePath).catch(() => { });
        await rmdir(requestDirectory).catch(() => { });
    }
}
export async function helper(requestPath: string, expectedHash: string): Promise<void> {
    const bytes = await readFile(requestPath);
    if (sha256(bytes) !== expectedHash) {
        throw new HostmanError('Commit request changed. No write performed.');
    }
    const request = JSON.parse(decode(bytes)) as CommitRequest;
    const response = `${requestPath}.result`;
    try {
        const changed = await commit(request);
        const file = await open(response,
            'wx',
            0o644);
        try {
            await file.writeFile(JSON.stringify({
                ok: true,
                changed
            }));
        } finally {
            await file.close();
        }
    } catch (error) {
        const file = await open(response,
            'wx',
            0o644);
        try {
            await file.writeFile(JSON.stringify({
                ok: false,
                error: (error as Error).message
            }));
        } finally {
            await file.close();
        }
        throw error;
    }
}
