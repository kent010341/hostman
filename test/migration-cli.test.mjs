import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from '#hostman/hosts/document';

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
 * @param {string[]} args Migration arguments.
 * @param {object[]} steps Expected prompt substrings and input keystrokes.
 * @returns {Promise<object>} Process result and captured terminal output.
 */
function interactive(f, args, steps) {
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

test('dry-run and scripted migration expose multi-target state without prompting', async t => {
    /** Purely commented source should import as disabled through the script interface. */
    const f = await fixture(t, '#127.0.0.1 www.example.test\n#192.0.2.1 api.example.test\n');
    /** Dry-run preserves original bytes and reports no effective selection. */
    const preview = spawnSync(process.execPath,
        [entry, '--hosts-file', f.path, 'migrate', '--dry-run'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /imported=127.0.0.1, imported-2=192.0.2.1/);
    assert.match(preview.stdout, /active: none \(disabled\); enable selects: imported/);
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
        assert.match(result.output, /imported=127.0.0.1, lab=192.0.2.1/);
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
    assert.match(result.stdout, /SKIP: Multiple effective/);
    assert.match(result.stdout, /line 1: 192.0.2.1 www.example.test/);
    assert.match(result.stdout, /line 2: 192.0.2.2 api.example.test/);
    assert.match(result.stdout, /No eligible imports; no changes/);
    assert.equal(await readFile(f.path, 'utf8'), f.source);
});
