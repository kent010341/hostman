import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';

/** Absolute built CLI entry used by subprocess integration checks. */
const entry = resolve('dist/cli/index.js');

/**
 * Prepare a disposable hosts source and a simulated TTY preload.
 * @param {object} t Node test context responsible for cleanup.
 * @param {string} source Original hosts content.
 * @returns {Promise<object>} Fixture paths and original bytes.
 */
async function fixture(t, source) {
    /** Dedicated directory, never the system hosts file. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-migration-cli-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Hosts file mutated only by this test. */
    const path = join(dir, 'sample hosts');
    /** Preload exposes terminal flags while allowing deterministic pipe-driven prompts. */
    const preload = join(dir, 'tty.mjs');
    await writeFile(path, source);
    await writeFile(preload,
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    return { path, preload, source };
}

/**
 * Drive real Inquirer prompts by responding after each expected prompt becomes visible.
 * @param {object} f Disposable source and TTY preload paths.
 * @param {string[]} args CLI arguments.
 * @param {object[]} steps Expected prompt substrings and input keystrokes.
 * @param {string} expectedSource Optional source bytes asserted before each prompt response.
 * @returns {Promise<object>} Process result and captured terminal output.
 */
function interactive(f, args, steps, expectedSource) {
    return new Promise((resolveResult, reject) => {
        /** CLI process with real prompt handling and simulated terminal detection. */
        const child = spawn(process.execPath,
            ['--import', pathToFileURL(f.preload).href, entry, '--no-hints', '--hosts-file', f.path, ...args]);
        /** Accumulated terminal output includes prompt redraws. */
        let output = '';
        /** Error output retained for assertions and timeout diagnostics. */
        let errors = '';
        /** Number of input responses already delivered. */
        let index = 0;
        /** Bound prompt tests so a regression cannot hang the suite. */
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Prompt timeout: ${output}\n${errors}`));
        }, 10000);
        child.stdout.on('data', value => {
            output += value.toString();
            if (index < steps.length && output.includes(steps[index].prompt)) {
                if (expectedSource !== undefined) {
                    try {
                        assert.equal(readFileSync(f.path, 'utf8'), expectedSource);
                    } catch (error) {
                        child.kill();
                        clearTimeout(timer);
                        reject(error);
                        return;
                    }
                }
                child.stdin.write(steps[index].keys);
                index++;
            }
        });
        child.stderr.on('data', value => errors += value.toString());
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolveResult({ code, output, errors, steps: index });
        });
    });
}

test('add group offers globals first and manual entry last without changing explicit arguments', async t => {
    /** Initialized source with two globals in definition order. */
    const source = transform(transform(transform('', { kind: 'init' }), {
        kind: 'global-add', name: 'local', ip: '192.0.2.1'
    }), { kind: 'global-add', name: 'office', ip: '192.0.2.2' });
    for (const [args, steps, active, targets, hosts, enabled] of [
        [['add', 'group'],
            [{ prompt: 'Two-label group root', keys: 'example.test\r' },
                { prompt: 'Initial target', keys: '\r' }], '@local', [], ['example.test'], true],
        [['add', 'group', 'example.test'],
            [{ prompt: 'Initial target', keys: '\r' }], '@local', [], ['example.test'], true],
        [['add', 'group', 'example.test', '--disabled', '--host', 'api'],
            [{ prompt: 'Initial target', keys: '\u001b[B\r' }],
            '@office', [], ['api.example.test'], false],
        [['add', 'group', 'example.test'],
            [{ prompt: 'Initial target', keys: '\u001b[A\r' },
                { prompt: 'Initial target name', keys: 'lab\r' },
                { prompt: 'IP address', keys: '\u001b[A\r' },
                { prompt: 'IP address', keys: '192.0.2.9\r' }],
            'lab', [{ name: 'lab', ip: '192.0.2.9' }], ['example.test'], true],
        [['add', 'group', 'example.test', '--target', 'lab=192.0.2.9'],
            [], 'lab', [{ name: 'lab', ip: '192.0.2.9' }], ['example.test'], true],
        [['add', 'group', 'example.test', '--active', '@office'],
            [], '@office', [], ['example.test'], true]
    ]) {
        /** Fresh fixture isolates each independent creation path. */
        const f = await fixture(t, source);
        /** Prompt responses verify that source bytes stay unchanged throughout input. */
        const result = await interactive(f, args, steps, source);
        assert.equal(result.code, 0, result.errors);
        assert.equal(result.steps, steps.length);
        /** Saved group distinguishes global selection from a same-named literal target. */
        const group = parse(await readFile(f.path, 'utf8')).document.groups[0];
        assert.equal(group.activeTarget, active);
        assert.deepEqual(group.targets, targets);
        assert.deepEqual(group.hosts, hosts);
        assert.equal(group.enabled, enabled);
        if (steps.length) {
            assert.ok(result.output.indexOf('@local (global, 192.0.2.1)')
                < result.output.indexOf('@office (global, 192.0.2.2)'));
            assert.ok(result.output.indexOf('@office (global, 192.0.2.2)')
                < result.output.indexOf('Enter a new group target'));
        } else {
            assert.doesNotMatch(result.output, /Initial target/);
        }
        if (active.startsWith('@')) {
            assert.doesNotMatch(result.output, /Initial target name|\? IP address/);
        }
    }
});

test('add group manual fallback and cancellation preserve bytes; scripts require explicit destinations', async t => {
    /** Existing globals must not become automatic script destinations. */
    const source = transform(transform('', { kind: 'init' }), {
        kind: 'global-add', name: 'local', ip: '192.0.2.1'
    });
    for (const steps of [
        [{ prompt: 'Initial target', keys: '\u0003' }],
        [{ prompt: 'Initial target', keys: '\u001b[A\r' },
            { prompt: 'Initial target name', keys: '\u0003' }],
        [{ prompt: 'Initial target', keys: '\u001b[A\r' },
            { prompt: 'Initial target name', keys: '\r' },
            { prompt: 'IP address', keys: '\u0003' }]
    ]) {
        /** Every cancellation starts from unchanged initialized source. */
        const f = await fixture(t, source);
        /** Cancelled prompts must never create a partial group. */
        const result = await interactive(f, ['add', 'group', 'example.test'], steps, source);
        assert.equal(result.steps, steps.length);
        assert.equal(await readFile(f.path, 'utf8'), source);
    }
    /** No globals still offers the manual destination option as the only menu item. */
    const empty = transform('', { kind: 'init' });
    /** Fresh source contains no shared definitions. */
    const f = await fixture(t, empty);
    /** Manual entry retains the historical local-name default after explicit selection. */
    const created = await interactive(f, ['add', 'group', 'example.test'], [
        { prompt: 'Enter a new group target', keys: '\r' },
        { prompt: 'Initial target name', keys: '\r' },
        { prompt: 'IP address', keys: '\u001b[A\r' },
        { prompt: 'IP address', keys: '192.0.2.9\r' }
    ], empty);
    assert.equal(created.code, 0, created.errors);
    assert.deepEqual(parse(await readFile(f.path, 'utf8')).document.groups[0].targets,
        [{ name: 'local', ip: '192.0.2.9' }]);
    await writeFile(f.path, source);
    /** Non-terminal invocations must supply destination arguments despite available globals. */
    const incomplete = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'add', 'group', 'example.test'], { encoding: 'utf8' });
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /required/);
    assert.equal(await readFile(f.path, 'utf8'), source);
});

for (const cancel of [false, true]) {
    test(`TTY target selection exposes direct globals: cancel=${cancel}`, async t => {
        /** Seed a local destination and a same-named global to prove explicit selection. */
        let source = transform('', { kind: 'init' });
        source = transform(source, { kind: 'global-add', name: 'local', ip: '127.0.0.2' });
        source = transform(source, {
            kind: 'add-group', group: {
                name: 'example.test', enabled: true, activeTarget: 'local',
                targets: [{ name: 'local', ip: '127.0.0.1' }], hosts: ['example.test']
            }
        });
        /** Dedicated hosts fixture and real Inquirer prompts. */
        const f = await fixture(t, source);
        /** Move from the first local choice to the global choice, or cancel. */
        const result = await interactive(f, ['use', 'example.test'], [
            { prompt: '@local (global, 127.0.0.2)', keys: cancel ? '\u0003' : '\u001b[B\r' }
        ]);
        assert.match(result.output, /local \(group, 127.0.0.1\)/);
        assert.equal(result.steps, 1);
        if (cancel) {
            assert.equal(await readFile(f.path, 'utf8'), source);
        } else {
            assert.equal(result.code, 0, result.errors);
            assert.equal(parse(await readFile(f.path, 'utf8')).document.groups[0].activeTarget, '@local');
        }
    });
}

test('CLI creates a global-only group and rejects reference target values without writing', async t => {
    /** Global definition exists before group creation. */
    const source = transform(transform('', { kind: 'init' }), {
        kind: 'global-add', name: 'local', ip: '127.0.0.1'
    });
    /** Disposable fixture reused by scripted and interactive invocations. */
    const f = await fixture(t, source);
    /** Explicit global active skips the initial-target prompt in a terminal. */
    const created = await interactive(f,
        ['add', 'group', 'example.test', '--active', '@local', '--host', '@'], []);
    assert.equal(created.code, 0, created.errors);
    assert.doesNotMatch(created.output, /Initial target name/);
    /** Successful source must contain no group target definitions. */
    const saved = await readFile(f.path, 'utf8');
    assert.deepEqual(parse(saved).document.groups[0].targets, []);
    for (const args of [
        ['target', 'add', 'example.test', 'shared', '@local'],
        ['add', 'group', 'other.test', '--target', 'shared=@local', '--host', '@'],
        ['use', 'example.test', '@missing'],
        ['global', 'remove', 'local']
    ]) {
        /** Invalid inputs and deletion of a selected global must preserve the source. */
        const result = spawnSync(process.execPath, [entry, '--hosts-file', f.path, ...args], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(f.path, 'utf8'), saved);
    }
    /** Show exposes both the global selection and resolved IP. */
    const shown = spawnSync(process.execPath, [entry, '--hosts-file', f.path, 'show', 'all'], { encoding: 'utf8' });
    assert.match(shown.stdout, /active=@local ip=127.0.0.1 CLEAN/);
    await writeFile(f.path, saved.replace('127.0.0.1 example.test', '192.0.2.9 example.test'));
    /** Global repair offers restore without a keep option that could mutate shared state. */
    const repaired = await interactive(f, ['repair', 'example.test'], [
        { prompt: 'Restore configured target', keys: '\r' }
    ]);
    assert.equal(repaired.code, 0, repaired.errors);
    assert.doesNotMatch(repaired.output, /Keep effective IP/);
    assert.equal(parse(await readFile(f.path, 'utf8')).groups[0].status, 'CLEAN');
});

test('dry-run and scripted migration expose multi-target state without prompting', async t => {
    /** Purely commented source should import as disabled through the script interface. */
    const f = await fixture(t, '#127.0.0.1 www.example.test\n#192.0.2.1 api.example.test\n');
    /** Dry-run preserves original bytes and reports no effective selection. */
    const preview = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'migrate', '--dry-run'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /example.test — READY\n {2}Targets:\n {4}imported=127.0.0.1\n/);
    assert.match(preview.stdout, / {4}imported-2=192.0.2.1\n {2}Hosts:\n/);
    assert.match(preview.stdout, / {2}Active: none \(disabled\)\n {2}Enable selects: imported/);
    assert.doesNotMatch(preview.stdout, /Target name for/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
    /** Explicit non-interactive selection accepts default names without prompts. */
    const imported = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'migrate', '--group', 'example.test'], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /Migration summary:/);
    assert.doesNotMatch(imported.stdout, /Target name for/);
    assert.equal(parse(await readFile(f.path, 'utf8')).document.groups[0].enabled, false);
});

for (const selection of [['--all'], ['--group', 'example.test'], []]) {
    test(`TTY migration names targets and summarizes before committing: ${selection.join(' ')}`, async t => {
        /** One inactive and one effective IP exercise renamed active selection. */
        const f = await fixture(t, '#192.0.2.1 www.example.test\n127.0.0.1 api.example.test\n');
        /** Checklist is required only without explicit selection flags. */
        const steps = [
            ...selection.length ? [] : [{ prompt: 'Select groups to migrate', keys: ' \r' }],
            { prompt: 'Target name for example.test (192.0.2.1)', keys: 'lab\r' },
            { prompt: 'Target name for example.test (127.0.0.1)', keys: '\r' },
            ...selection.length ? [] : [{ prompt: 'Move selected rules into hostman', keys: 'y\r' }]
        ];
        /** Actual Inquirer input responses exercise Enter defaults and custom names. */
        const result = await interactive(f, ['migrate', ...selection], steps);
        assert.equal(result.code, 0, result.errors);
        assert.equal(result.steps, steps.length);
        assert.match(result.output, /Migration summary:/);
        assert.match(result.output, /Migration summary:\nexample.test\n {2}Targets:\n/);
        assert.match(result.output, / {4}imported=127.0.0.1\n {4}lab=192.0.2.1\n/);
        assert.match(result.output, / {2}Active: imported \(enabled\)/);
        /** Final active target must use the accepted default for the effective IP. */
        const parsed = parse(await readFile(f.path, 'utf8'));
        assert.equal(parsed.document.groups[0].activeTarget, 'imported');
        assert.equal(parsed.groups[0].status, 'CLEAN');
        if (!selection.length) {
            assert.ok(result.output.indexOf('Migration summary:')
                < result.output.indexOf('Move selected rules into hostman'));
        }
    });
}

test('cancelling a target naming prompt leaves source bytes unchanged', async t => {
    /** Cancellation occurs before any transform is committed. */
    const f = await fixture(t, '#127.0.0.1 www.example.test\n');
    /** Ctrl+C is delivered through Inquirer input handling. */
    const result = await interactive(f, ['migrate', '--all'],
        [{ prompt: 'Target name for example.test (127.0.0.1)', keys: '\x03' }]);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.output, /Migration summary:/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
});

test('declining the final migration confirmation leaves source bytes unchanged', async t => {
    /** Interactive selection and naming can be completed without authorizing a write. */
    const f = await fixture(t, '#127.0.0.1 www.example.test\n');
    /** Enter accepts the default false confirmation after the final summary. */
    const result = await interactive(f, ['migrate'], [
        { prompt: 'Select groups to migrate', keys: ' \r' },
        { prompt: 'Target name for example.test (127.0.0.1)', keys: '\r' },
        { prompt: 'Move selected rules into hostman', keys: '\r' }
    ]);
    assert.equal(result.code, 0, result.errors);
    assert.match(result.output, /Cancelled; no changes/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
});

test('CLI conflicts identify outside rules and preserve the complete source', async t => {
    /** Multiple effective IPs are not imported even with --all. */
    const f = await fixture(t, '192.0.2.1 www.example.test\n192.0.2.2 api.example.test\n');
    /** Non-interactive preview explains the entire skipped group. */
    const result = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'migrate', '--all'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /example.test — SKIP\n {2}Reason: Multiple effective/);
    assert.match(result.stdout, / {4}Line 1 {2}192.0.2.1 {2}www.example.test {2}\[effective\]/);
    assert.match(result.stdout, / {4}Line 2 {2}192.0.2.2 {2}api.example.test {2}\[effective\]/);
    assert.match(result.stdout, /Action: Keep one effective IP/);
    assert.doesNotMatch(result.stdout, /Targets:|Hosts:|Active:|Enable selects:|imported=/);
    assert.match(result.stdout, /No eligible imports; no changes/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
});

test('migration blocks separate groups and list each original source line only once', async t => {
    /** Mixed ready and skipped proposals exercise block boundaries and alias diagnostic grouping. */
    const f = await fixture(t, '#127.0.0.1 www.ready.test\n'
        + '192.0.2.1 www.skipped.test api.skipped.test www.skipped.test\n'
        + '192.0.2.2 iot.skipped.test\n#192.0.2.3 lab.skipped.test\n');
    /** Dry-run renders source details without conflating a skipped proposal with disabled state. */
    const preview = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'migrate', '--dry-run'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Enable selects: imported\n\nskipped.test — SKIP/);
    assert.equal(preview.stdout.match(/Line 2 /g).length, 1);
    assert.match(preview.stdout, /Line 2 {2}192.0.2.1 {2}www.skipped.test, api.skipped.test {2}\[effective\]/);
    assert.match(preview.stdout, /Line 4 {2}192.0.2.3 {2}lab.skipped.test {2}\[commented\]/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
});
