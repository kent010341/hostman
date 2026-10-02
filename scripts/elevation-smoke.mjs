import {
    mkdtemp, writeFile, readFile, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join, resolve, win32
} from 'node:path';
import assert from 'node:assert/strict';
import {
    execute, readSource, run
} from '../dist/fs/storage.js';
import { transform } from '../dist/domain/operations.js';
import { sha256 } from '../dist/domain/model.js';
if (process.platform !== 'win32') {
    throw new Error('This manual UAC check requires Windows.');
}
const directory = await mkdtemp(join(tmpdir(),
    'hostman-uac-'));
const fixture = join(directory,
    'sample hosts');
const powershell = win32.join(process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe');
const env = {
    ...process.env,
    PSModulePath: win32.join(process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'Modules')
};
const protect = args => run(powershell,
    [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/protected-fixture.ps1'),
        ...args
    ],
    false,
    env);
let descriptor;
try {
    await writeFile(fixture,
        '127.0.0.1 localhost\n');
    const source = await readSource(fixture), operation = { kind: 'init' };
    descriptor = await protect([
        '-Path',
        directory,
        '-Mode',
        'Protect'
    ]);
    console.log(`Protected fixture: ${fixture}. Approve the Windows UAC prompt to test the real commit helper.`);
    const request = {
        version: 1,
        sourcePath: source.path,
        sourceDigest: source.digest,
        operation,
        resultDigest: sha256(transform(source.text,
            operation))
    };
    assert.equal(await execute(request,
        {
            interactive: true,
            allowElevation: true,
            notify: console.log
        }),
    true);
    assert.equal(sha256(await readFile(fixture)),
        request.resultDigest);
    console.log('Actual protected-fixture UAC commit passed.');
} finally {
    if (descriptor) {
        await protect([
            '-Path',
            directory,
            '-Mode',
            'Restore',
            '-Descriptor',
            descriptor
        ]);
    }
    await rm(directory,
        {
            recursive: true,
            force: true
        });
}
