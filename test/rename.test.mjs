import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, serialize } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';
import { sha256 } from '#hostman/domain/model';
import { readSource, run } from '#hostman/fs/storage';

/** Build enabled and disabled groups with active and inactive shared references. @returns Managed fixture text. */
function fixture() {
    return serialize(parse('127.0.0.1 localhost\r\n'), {
        version: 1,
        globals: [{ name: 'shared', ip: '192.0.2.1' }, { name: 'other', ip: '192.0.2.2' }],
        groups: ['example.com', 'example.net', 'example.org'].map((name, index) => ({
            name,
            enabled: index !== 1,
            activeTarget: index === 2 ? 'literal' : 'local',
            targets: [
                { name: 'local', source: 'global', globalName: 'shared' },
                { name: 'backup', source: 'global', globalName: 'shared' },
                { name: 'literal', source: 'group', ip: '192.0.2.3' }
            ],
            hosts: [name]
        }))
    });
}

test('group rename preserves destinations, enabled state and active selection', () => {
    /** Original managed source shared by independent rename cases. */
    const before = fixture();
    for (const group of ['example.com', 'example.net']) {
        for (const target of ['local', 'backup', 'literal']) {
            /** Renamed text includes a recomputed group digest. */
            const result = transform(before, { kind: 'target-rename', group, target, newName: 'renamed' });
            /** Expected document differs only in target names and the matching active selection. */
            const expected = parse(before).document;
            /** Group whose active and inactive targets are exercised. */
            const owner = expected.groups.find(g => g.name === group);
            owner.targets.find(t => t.name === target).name = 'renamed';
            if (owner.activeTarget === target) {
                owner.activeTarget = 'renamed';
            }
            assert.deepEqual(parse(result).document, parse(serialize(parse(before), expected)).document);
            assert.ok(parse(result).groups.every(g => g.status === 'CLEAN'));
            assert.deepEqual(result.match(/^192\.0\.2\..*$/gm), before.match(/^192\.0\.2\..*$/gm));
        }
    }
});

test('global rename updates all active, inactive and disabled references', () => {
    /** Source containing multiple references in each group. */
    const before = fixture();
    /** Expected definitions keep local names and active selections. */
    const expected = parse(before).document;
    expected.globals[0].name = 'renamed';
    for (const group of expected.groups) {
        for (const target of group.targets) {
            if (target.source === 'global') {
                target.globalName = 'renamed';
            }
        }
    }
    /** All referencing blocks must receive fresh digests. */
    const result = transform(before, { kind: 'global-rename', name: 'shared', newName: 'renamed' });
    assert.deepEqual(parse(result).document, expected);
    assert.ok(parse(result).groups.every(g => g.status === 'CLEAN'));
    assert.deepEqual(result.match(/^192\.0\.2\..*$/gm), before.match(/^192\.0\.2\..*$/gm));
});

test('renames reject missing, duplicate and invalid names and preserve same-name no-ops', () => {
    /** Pristine source used for every failed transformation. */
    const before = fixture();
    for (const operation of [
        { kind: 'target-rename', group: 'example.com', target: 'local', newName: 'local' },
        { kind: 'global-rename', name: 'shared', newName: 'shared' }
    ]) {
        assert.equal(transform(before, operation), before);
        for (const newName of ['', 'bad name', '@shared', undefined]) {
            assert.throws(() => transform(before, { ...operation, newName }), /Invalid.*name/);
        }
        assert.throws(() => transform(before, {
            ...operation, newName: operation.kind === 'target-rename' ? 'literal' : 'other'
        }), /already exists/);
        assert.throws(() => transform(before, { ...operation, target: 'missing', name: 'missing' }), /Unknown/);
    }
    assert.throws(() => transform(before, {
        kind: 'target-rename', group: 'missing.com', target: 'local', newName: 'renamed'
    }), /Unknown group/);
});

test('renames preserve valid manual additions and block affected conflicts', () => {
    /** Manual hostname addition is adopted when the referring group is touched. */
    const dirty = fixture().replace('192.0.2.1 example.com', '192.0.2.1 example.com extra.example.com');
    for (const operation of [
        { kind: 'target-rename', group: 'example.com', target: 'local', newName: 'dev' },
        { kind: 'global-rename', name: 'shared', newName: 'dev' }
    ]) {
        assert.ok(parse(transform(dirty, operation)).document.groups[0].hosts.includes('extra.example.com'));
        assert.throws(() => transform(dirty.replace('192.0.2.1 example.com', '192.0.2.99 example.com'), operation),
            /Conflicted scope/);
    }
});

test('global rename permits unrelated group conflicts and unreferenced globals', () => {
    /** Broken group does not reference the global being renamed. */
    const before = fixture().replace('192.0.2.1 example.com', '192.0.2.99 example.com');
    /** Unreferenced global can change without rewriting damaged or unrelated group blocks. */
    const result = transform(before, { kind: 'global-rename', name: 'other', newName: 'unused' });
    assert.equal(result, before.replace('# global other=', '# global unused='));
    assert.equal(transform(result, { kind: 'global-rename', name: 'unused', newName: 'unused' }), result);
});

test('TTY rename prompts finish before writes and cancellation preserves the source', async t => {
    /** Disposable directory contains both source and terminal preload. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-rename-tty-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Custom hosts path for real Inquirer subprocesses. */
    const path = join(dir, 'sample hosts');
    /** Simulated terminal flags enable ordinary interactive behavior. */
    const preload = join(dir, 'tty.mjs');
    await writeFile(preload,
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    for (const [args, prompt] of [
        [['target', 'rename', 'example.com', 'local'], 'New target name'],
        [['global', 'rename', 'shared'], 'New global target name']
    ]) {
        for (const cancel of [false, true]) {
            await writeFile(path, fixture());
            /** Expected bytes before submitting the final missing argument. */
            const before = await readFile(path, 'utf8');
            /** Interactive result from responding only once the prompt is visible. */
            const result = await new Promise((resolveResult, reject) => {
                /** CLI process runs actual Inquirer prompts through pipes. */
                const child = spawn(process.execPath, [
                    '--import', pathToFileURL(preload).href, resolve('dist/cli/index.js'),
                    '--no-hints', '--hosts-file', path, ...args
                ]);
                /** Terminal redraws accumulated for prompt detection. */
                let output = '';
                /** Prevent duplicate responses on redraw. */
                let responded = false;
                /** Abort regressions that would otherwise leave the test hanging. */
                const timer = setTimeout(() => {
                    child.kill();
                    reject(new Error(`Rename prompt timeout: ${output}`));
                }, 10000);
                child.stdout.on('data', async value => {
                    output += value.toString();
                    if (!responded && output.includes(prompt)) {
                        responded = true;
                        try {
                            assert.equal(await readFile(path, 'utf8'), before);
                            child.stdin.write(cancel ? '\u0003' : 'renamed\r');
                        } catch (error) {
                            child.kill();
                            reject(error);
                        }
                    }
                });
                child.on('error', error => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.on('close', code => {
                    clearTimeout(timer);
                    resolveResult({ code, responded });
                });
            });
            assert.equal(result.responded, true);
            assert.equal(result.code, cancel ? 1 : 0);
            if (cancel) {
                assert.equal(await readFile(path, 'utf8'), before);
            } else {
                assert.ok((await readFile(path, 'utf8')).includes('renamed'));
                assert.ok(parse(await readFile(path, 'utf8')).groups.every(g => g.status === 'CLEAN'));
            }
        }
    }
});

test('CLI and compiled helper replay renames without changing IPs', async t => {
    /** Disposable hosts fixture used by CLI and privileged helper protocol. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-rename-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Custom source includes spaces to exercise argument handling. */
    const path = join(dir, 'sample hosts');
    await writeFile(path, fixture());
    for (const args of [
        ['target', 'rename', 'example.com', 'local', 'dev'],
        ['global', 'rename', 'shared', 'central']
    ]) {
        /** Real CLI writes the custom fixture using normal transaction handling. */
        const result = spawnSync(process.execPath, [resolve('dist/cli/index.js'), '--hosts-file', path, ...args],
            { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    /** Missing script arguments fail without writing. */
    const before = await readFile(path, 'utf8');
    for (const args of [['target', 'rename', 'example.com', 'dev'], ['global', 'rename', 'central']]) {
        /** Scripts cannot fall back to interactive naming prompts. */
        const result = spawnSync(process.execPath, [resolve('dist/cli/index.js'), '--hosts-file', path, ...args],
            { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /required/);
        assert.equal(await readFile(path, 'utf8'), before);
    }
    for (const operation of [
        { kind: 'target-rename', group: 'example.com', target: 'dev', newName: 'local' },
        { kind: 'global-rename', name: 'central', newName: 'shared' }
    ]) {
        /** Fresh snapshot for independently replayed helper transactions. */
        const source = await readSource(path);
        /** Domain preview must exactly match the helper's output. */
        const expected = transform(source.text, operation);
        /** Hashed request accepted by the compiled helper. */
        const bytes = JSON.stringify({
            version: 1, sourcePath: source.path, sourceDigest: source.digest,
            operation, resultDigest: sha256(expected)
        });
        /** Request file stays inside the disposable test directory. */
        const requestPath = join(dir, `${operation.kind}.json`);
        await writeFile(requestPath, bytes);
        await run(process.execPath, [resolve('dist/fs/helper.js'), '--commit-request', requestPath, sha256(bytes)]);
        assert.equal(await readFile(path, 'utf8'), expected);
    }
    assert.equal(await readFile(path, 'utf8'), fixture());
});
