import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { parse, serialize } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';

/**
 * Create two scopes with same-named targets and a disabled global reference.
 * @returns Managed hosts text for selection tests.
 */
function fixture() {
    return serialize(parse('127.0.0.1 localhost\n'), {
        version: 1,
        globals: [{ name: 'local', ip: '192.0.2.1' }, { name: 'free', ip: '192.0.2.2' }],
        groups: ['example.com', 'example.net'].map((name, index) => ({
            name,
            enabled: index === 0,
            activeTarget: index === 0 ? 'local' : '@local',
            targets: [{ name: 'local', ip: '192.0.2.3' }, { name: 'backup', ip: '192.0.2.4' }],
            hosts: [name, `api.${name}`]
        }))
    });
}

/**
 * Respond to real Inquirer prompts while verifying that selection does not write.
 * @param path Disposable source path.
 * @param preload Terminal flag preload path.
 * @param args CLI arguments.
 * @param steps Prompt labels and terminal responses.
 * @param cancelAt Prompt index to cancel, or undefined for success.
 * @returns Exit status, prompt count and captured output.
 */
async function terminal(path, preload, args, steps, cancelAt) {
    /** Bytes that must survive until every prompt has been answered. */
    const before = await readFile(path, 'utf8');
    return new Promise((resolveResult, reject) => {
        /** Subprocess uses actual prompts and the normal transaction path. */
        const child = spawn(process.execPath, [
            '--import', pathToFileURL(preload).href, resolve('dist/cli/index.js'),
            '--no-hints', '--hosts-file', path, ...args
        ]);
        /** Redraw output used to detect prompts once each. */
        let output = '';
        /** Output since the last response avoids matching a previous prompt. */
        let promptOutput = '';
        /** Next unanswered prompt index. */
        let answered = 0;
        /** Pending fixture assertion must finish before returning the result. */
        let pending = Promise.resolve();
        /** Guard against a broken prompt flow hanging the suite. */
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Selection timeout: ${output}`));
        }, 10000);
        child.stdout.on('data', value => {
            output += value.toString();
            promptOutput += stripVTControlCharacters(value.toString());
            if (answered < steps.length && promptOutput.includes(steps[answered].prompt)) {
                /** Reserve the response before awaiting the filesystem. */
                const index = answered++;
                promptOutput = '';
                pending = pending.then(async () => {
                    assert.equal(await readFile(path, 'utf8'), before);
                    child.stdin.write(index === cancelAt ? '\u0003' : steps[index].keys);
                }).catch(error => {
                    child.kill();
                    reject(error);
                });
            }
        });
        child.stderr.on('data', value => {
            output += value.toString();
        });
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', async code => {
            clearTimeout(timer);
            await pending;
            resolveResult({ code, answered, output });
        });
    });
}

test('existing-item menus select within scope and complete prompts before writing', async t => {
    /** Isolated source and terminal preload directory. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-selection-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Source path containing spaces exercises custom-source handling. */
    const path = join(dir, 'sample hosts');
    /** Simulated terminal flags enable actual Inquirer prompts through pipes. */
    const preload = join(dir, 'tty.mjs');
    await writeFile(preload,
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    for (const [args, steps, operation, visible, absent] of [
        [['remove', 'host', 'example.com'],
            [{ prompt: 'Hostname to remove', keys: '\r' }],
            { kind: 'remove-host', group: 'example.com', host: 'api.example.com' },
            'api.example.com', 'api.example.net'],
        [['remove', 'host'],
            [{ prompt: 'Group', keys: '\u001b[B\r' },
                { prompt: 'Hostname to remove', keys: '\u001b[B\r' }],
            { kind: 'remove-host', group: 'example.net', host: 'example.net' }],
        [['target', 'set'],
            [{ prompt: 'Group', keys: '\r' }, { prompt: 'Target to set', keys: '\u001b[B\r' },
                { prompt: 'IP address', keys: '\u001b[A\r' },
                { prompt: '? IP address', keys: '192.0.2.9\r' }],
            { kind: 'target-set', group: 'example.com', target: { name: 'local', ip: '192.0.2.9' } },
            'local (192.0.2.3)', 'local (192.0.2.1)'],
        [['target', 'remove'],
            [{ prompt: 'Group', keys: '\r' }, { prompt: 'Target to remove', keys: '\u001b[A\r' },
                { prompt: 'This option is disabled and cannot be selected.', keys: '\u001b[B\r' }],
            { kind: 'target-remove', group: 'example.com', target: 'backup' },
            'Active target; switch targets first'],
        [['global', 'set'],
            [{ prompt: 'Global target to set', keys: '\r' },
                { prompt: 'IP address', keys: '\u001b[A\r' },
                { prompt: '? IP address', keys: '192.0.2.9\r' }],
            { kind: 'global-set', name: 'local', ip: '192.0.2.9' }, 'local (192.0.2.1)', 'local (192.0.2.3)'],
        [['global', 'remove'],
            [{ prompt: 'Global target to remove', keys: '\r' },
                { prompt: 'This option is disabled and cannot be selected.', keys: '\u001b[B\r' }],
            { kind: 'global-remove', name: 'free' }, 'Selected by example.net']
    ]) {
        for (const cancelAt of [undefined, ...steps.map((_, index) => index)]) {
            await writeFile(path, fixture());
            /** Result includes rendered choice names and disabled explanations. */
            const result = await terminal(path, preload, args, steps, cancelAt);
            assert.equal(result.code, cancelAt === undefined ? 0 : 1, result.output);
            assert.equal(result.answered, cancelAt === undefined ? steps.length : cancelAt + 1, result.output);
            assert.equal(await readFile(path, 'utf8'),
                cancelAt === undefined ? transform(fixture(), operation) : fixture());
            if (cancelAt === undefined) {
                if (visible) {
                    assert.ok(result.output.includes(visible), result.output);
                }
                if (absent) {
                    assert.ok(!result.output.includes(absent), result.output);
                }
                assert.ok(parse(await readFile(path, 'utf8')).groups.every(g => g.status === 'CLEAN'));
            }
        }
    }
});

test('empty or protected lists fail immediately; scripts retain explicit arguments and validation', async t => {
    /** Disposable hosts and terminal fixtures. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-selection-errors-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Custom source shared by independent cases. */
    const path = join(dir, 'hosts');
    /** Preload turns on interactive selection without sending input. */
    const preload = join(dir, 'tty.mjs');
    await writeFile(preload,
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    /** Initialized document with empty and entirely protected scopes. */
    const document = parse(fixture()).document;
    document.groups[0].hosts = [];
    document.groups[0].targets = document.groups[0].targets.filter(target => target.name === 'local');
    document.groups[1].targets = [];
    document.globals = document.globals.filter(target => target.name === 'local');
    /** Canonical fixture makes failures byte-comparable. */
    const before = serialize(parse('127.0.0.1 localhost\n'), document);
    await writeFile(path, before);
    for (const [args, message] of [
        [['remove', 'host', 'example.com'], /No hostnames.*add host/],
        [['remove', 'host', 'missing.test'], /Unknown group/],
        [['target', 'set', 'missing.test'], /Unknown group/],
        [['target', 'set', 'example.net'], /No targets.*target add/],
        [['target', 'remove', 'example.com'], /No removable targets.*Switch/],
        [['global', 'remove'], /No removable global targets.*Switch/]
    ]) {
        /** Missing candidates must fail without a prompt or write. */
        const result = spawnSync(process.execPath, [
            '--import', pathToFileURL(preload).href, resolve('dist/cli/index.js'),
            '--hosts-file', path, ...args
        ], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.equal(await readFile(path, 'utf8'), before);
    }
    await writeFile(path, transform('127.0.0.1 localhost\n', { kind: 'init' }));
    for (const action of ['set', 'rename', 'remove']) {
        /** All shared target operations handle a genuinely empty global list. */
        const result = spawnSync(process.execPath, [
            '--import', pathToFileURL(preload).href, resolve('dist/cli/index.js'),
            '--hosts-file', path, 'global', action
        ], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /No global targets.*global add/);
    }
    for (const args of [
        ['remove', 'host', 'example.com'], ['target', 'set', 'example.com'],
        ['target', 'remove', 'example.com'], ['global', 'set'], ['global', 'remove'],
        ['target', 'remove', 'example.com', 'local'], ['global', 'remove', 'local']
    ]) {
        await writeFile(path, fixture());
        /** Noninteractive missing names and explicit protected names remain domain errors. */
        const result = spawnSync(process.execPath,
            [resolve('dist/cli/index.js'), '--hosts-file', path, ...args], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /required|Cannot remove/);
        assert.equal(await readFile(path, 'utf8'), fixture());
    }
    for (const args of [
        ['remove', 'host', 'example.com', 'api'], ['target', 'set', 'example.com', 'local', '192.0.2.9'],
        ['target', 'remove', 'example.com', 'backup'], ['global', 'set', 'free', '192.0.2.9'],
        ['global', 'remove', 'free']
    ]) {
        await writeFile(path, fixture());
        /** Complete terminal arguments skip selection, including hostname shorthand. */
        const result = spawnSync(process.execPath, [
            '--import', pathToFileURL(preload).href, resolve('dist/cli/index.js'),
            '--no-hints', '--hosts-file', path, ...args
        ], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /to remove|to set/);
    }
});
