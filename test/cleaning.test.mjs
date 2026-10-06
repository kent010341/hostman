import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, serialize, candidates } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';
import { targetCleanPlan, globalCleanPlan } from '#hostman/domain/cleaning';
import { sha256 } from '#hostman/domain/model';
import { readSource, run } from '#hostman/fs/storage';

/** Built CLI used for fixture-only integration tests. */
const entry = resolve('dist/cli/index.js');

/**
 * Build duplicate globals and local destinations with enabled and disabled consumers.
 * @returns {string} Managed source with preserved unmanaged content and CRLF endings.
 */
function fixture() {
    return serialize(parse('\uFEFF127.0.0.1 localhost\r\n# manual content\r\n'), {
        version: 1,
        globals: [
            { name: 'local', ip: '192.0.2.1' },
            { name: 'office', ip: '192.0.2.1' },
            { name: 'six', ip: '2001:db8::1' },
            { name: 'sixdup', ip: '2001:0db8:0:0:0:0:0:1' },
            { name: 'unique', ip: '192.0.2.9' }
        ],
        groups: ['example.com', 'example.net', 'example.org'].map((name, index) => ({
            name,
            enabled: index !== 1,
            activeTarget: index === 0 ? 'local' : '@office',
            targets: [
                { name: 'local', ip: '192.0.2.1' },
                { name: 'foo', ip: '192.0.2.2' },
                { name: 'bar', ip: '192.0.2.2' }
            ],
            hosts: [name, `www.${name}`]
        }))
    });
}

test('target cleanup handles active and inactive global matches and local retention', () => {
    /** Fresh source for independent active and disabled cases. */
    const original = fixture();
    assert.throws(() => transform(original, { kind: 'target-clean', group: 'example.com' }), /Choose a global/);
    for (const active of ['local', 'foo', 'bar']) {
        /** Active literal selection can either become global or redirect to the retained local. */
        const before = transform(original, { kind: 'use', group: 'example.com', target: active });
        /** Explicit global and local choices must preserve the selected semantic destination. */
        const result = transform(before, {
            kind: 'target-clean', group: 'example.com', globalNames: ['office'], keep: ['example.com=bar']
        });
        /** Unrelated groups and definitions remain intact. */
        const expected = parse(before).document;
        expected.groups[0].targets = [{ name: 'bar', ip: '192.0.2.2' }];
        expected.groups[0].activeTarget = active === 'local' ? '@office' : 'bar';
        assert.deepEqual(parse(result).document, expected);
        assert.ok(parse(result).groups.every(group => group.status === 'CLEAN'));
        assert.deepEqual(result.match(/^192\.0\.2\..*$/gm), before.match(/^192\.0\.2\..*$/gm));
        assert.ok(result.startsWith('\uFEFF127.0.0.1 localhost\r\n# manual content\r\n'));
        assert.equal(transform(result, { kind: 'target-clean', group: 'example.com' }), result);
    }
    /** Disabled direct consumer keeps its shared selection and needs no ambiguous global prompt. */
    const disabled = parse(transform(original, { kind: 'target-clean', group: 'example.net' })).document.groups[1];
    assert.equal(disabled.activeTarget, '@office');
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.targets, [{ name: 'bar', ip: '192.0.2.2' }]);
    /** Scripts retain an active duplicate rather than the first source definition. */
    const activeFoo = transform(original, { kind: 'use', group: 'example.com', target: 'foo' });
    assert.equal(parse(transform(activeFoo, {
        kind: 'target-clean', group: 'example.com', globalNames: ['local']
    })).document.groups[0].targets[0].name, 'foo');
});

test('global cleanup redirects enabled and disabled consumers without touching local targets', () => {
    /** Original fixture with two distinct duplicate global IP buckets. */
    const before = fixture();
    /** All duplicate IPs require explicit retention in domain/helper replay. */
    const operation = { kind: 'global-clean', keep: ['local', 'sixdup'] };
    assert.throws(() => transform(before, { kind: 'global-clean', keep: ['local'] }), /Choose a global/);
    /** Only global definitions and referring active selections change. */
    const expected = parse(before).document;
    expected.globals = expected.globals.filter(target => !['office', 'six'].includes(target.name));
    expected.groups[1].activeTarget = '@local';
    expected.groups[2].activeTarget = '@local';
    /** Global cleanup is independent from the remaining local duplicate definitions. */
    const result = transform(before, operation);
    assert.deepEqual(parse(result).document, expected);
    assert.ok(parse(result).groups.every(group => group.status === 'CLEAN'));
    assert.equal(transform(result, { kind: 'global-clean' }), result);
    assert.deepEqual(result.match(/^192\.0\.2\..*$/gm), before.match(/^192\.0\.2\..*$/gm));
});

test('cleanup rejects invalid, unrelated, contradictory and malformed payloads', () => {
    /** Original bytes are never modified by failed pure transformations. */
    const before = fixture();
    for (const globalNames of [['missing'], ['local', 'office'], ['six'], null, 'local', [42]]) {
        assert.throws(() => transform(before, { kind: 'target-clean', group: 'example.com', globalNames }),
            /Invalid|conflicting/);
    }
    for (const keep of [['example.com=local'], ['example.net=bar'], ['example.com=foo', 'example.com=bar'], null]) {
        assert.throws(() => transform(before, {
            kind: 'target-clean', group: 'example.com', globalNames: ['local'], keep
        }), /Invalid|conflicting/);
    }
    for (const keep of [['unique'], ['local', 'office'], ['missing'], null, [false]]) {
        assert.throws(() => transform(before, { kind: 'global-clean', keep }), /Invalid|conflicting/);
    }
    assert.throws(() => transform(before, { kind: 'target-clean', group: 'missing.com' }), /Unknown group/);
    assert.throws(() => transform('127.0.0.1 localhost\n', { kind: 'global-clean' }), /No hostman section/);
});

test('cleanup retains manual host additions, validates affected scope and isolates other conflicts', () => {
    /** Valid manual hostname additions must survive serialization. */
    const dirty = fixture().replace('192.0.2.1 example.com', '192.0.2.1 example.com extra.example.com');
    assert.ok(parse(transform(dirty, {
        kind: 'target-clean', group: 'example.com', globalNames: ['local']
    })).document.groups[0].hosts.includes('extra.example.com'));
    /** Broken literal owner is unrelated to global redirects. */
    const conflict = dirty.replace('192.0.2.1 example.com', '192.0.2.99 example.com');
    assert.throws(() => transform(conflict, {
        kind: 'target-clean', group: 'example.com', globalNames: ['local']
    }), /Conflicted scope/);
    assert.doesNotThrow(() => transform(conflict, { kind: 'target-clean', group: 'example.net' }));
    assert.doesNotThrow(() => transform(conflict, { kind: 'global-clean', keep: ['local', 'six'] }));
    /** A conflicting redirected direct consumer must block the complete global transaction. */
    const referred = fixture().replace('192.0.2.1 example.org', '192.0.2.99 example.org');
    assert.throws(() => transform(referred, { kind: 'global-clean', keep: ['local', 'six'] }), /Conflicted scope/);
    assert.throws(() => transform('# >>> hostman v1\n', { kind: 'global-clean' }), /Unclosed/);
});

test('semantic global reuse can remove all local targets while retaining a disabled selection', () => {
    /** Sole local target uses an equivalent IPv6 spelling. */
    const source = serialize(parse(''), { version: 1,
        globals: [{ name: 'shared', ip: '2001:db8::1' }],
        groups: [{ name: 'example.com', enabled: false, activeTarget: 'shared',
            targets: [{ name: 'shared', ip: '2001:0db8:0:0:0:0:0:1' }], hosts: [] }]
    });
    /** Same-named local/global destinations remain distinguishable by the selection prefix. */
    const result = parse(transform(source, { kind: 'target-clean', group: 'example.com' }));
    assert.equal(result.document.groups[0].activeTarget, '@shared');
    assert.deepEqual(result.document.groups[0].targets, []);
    assert.equal(result.document.groups[0].enabled, false);
    assert.equal(result.groups[0].status, 'CLEAN');
});

test('migration reuses new global destinations, requires ambiguity choices and preserves existing definitions', () => {
    /** New groups contain both effective and commented globally matching destinations. */
    const source = fixture() + '192.0.2.1 www.new.test\r\n#2001:db8::1 api.new.test\r\n';
    /** Preview keeps unresolved choices separate from deterministic imported names. */
    const candidate = candidates(parse(source))[0];
    assert.equal(candidate.activeTarget, '');
    assert.equal(candidate.targets.every(target => !target.create), true);
    assert.throws(() => transform(source, { kind: 'migrate', groups: ['new.test'] }), /Choose a global/);
    /** Explicit choices yield direct global selection and no group-owned definitions. */
    const result = parse(transform(source, {
        kind: 'migrate', groups: ['new.test'], globalNames: ['office', 'six']
    }));
    assert.equal(result.document.groups.at(-1).activeTarget, '@office');
    assert.deepEqual(result.document.groups.at(-1).targets, []);
    assert.equal(result.groups.at(-1).status, 'CLEAN');
    /** Existing literal destinations and active selection take precedence over equivalent globals. */
    const existing = fixture() + '192.0.2.1 api.example.com\r\n#192.0.2.9 other.example.com\r\n';
    /** Only the newly encountered unique global destination participates in global selection. */
    const merged = parse(transform(existing, { kind: 'migrate', groups: ['example.com'] }));
    assert.equal(merged.document.groups[0].activeTarget, 'local');
    assert.deepEqual(merged.document.groups[0].targets, parse(existing).document.groups[0].targets);
    assert.ok(merged.document.groups[0].hosts.includes('other.example.com'));
    assert.throws(() => transform(existing, {
        kind: 'migrate', groups: ['example.com'], globalNames: ['office']
    }), /unrelated/);
    /** Commented-only new groups retain a global for their future enable. */
    const disabled = parse(transform(fixture() + '#192.0.2.9 new.disabled.test\r\n', {
        kind: 'migrate', groups: ['disabled.test']
    })).document.groups.at(-1);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.activeTarget, '@unique');
    assert.deepEqual(disabled.targets, []);
});

test('preview plans expose pending choices and deterministic local defaults without mutation', () => {
    /** Parsed definitions are preserved by all preview helpers. */
    const document = parse(fixture()).document;
    /** Deep snapshot guards against accidental in-place changes. */
    const before = structuredClone(document);
    assert.equal(targetCleanPlan(document, 'example.com').globals[0].selected, undefined);
    assert.equal(targetCleanPlan(document, 'example.com').locals[0].selected, 'bar');
    assert.equal(globalCleanPlan(document).length, 2);
    assert.deepEqual(document, before);
});

test('CLI supports scripts, pending dry runs, validation, summaries and no-op byte preservation', async t => {
    /** Disposable source directory for actual CLI transactions. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-clean-cli-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Custom source path includes spaces. */
    const path = join(dir, 'sample hosts');
    for (const args of [
        ['target', 'clean', 'example.com', '--dry-run'],
        ['global', 'clean', '--dry-run'],
        ['migrate', '--all', '--dry-run']
    ]) {
        await writeFile(path, fixture() + '#192.0.2.1 new.example.test\r\n');
        /** Dry-run output must disclose ambiguity without prompting or mutation. */
        const result = spawnSync(process.execPath, [entry, '--hosts-file', path, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /pending selection/);
        assert.equal(await readFile(path, 'utf8'), fixture() + '#192.0.2.1 new.example.test\r\n');
    }
    /** Explicit dry-run choices must resolve the preview rather than still displaying pending active state. */
    const resolvedPreview = spawnSync(process.execPath,
        [entry, '--hosts-file', path, 'migrate', '--all', '--dry-run', '--global', 'office'], { encoding: 'utf8' });
    assert.equal(resolvedPreview.status, 0, resolvedPreview.stderr);
    assert.doesNotMatch(resolvedPreview.stdout, /pending selection/);
    assert.match(resolvedPreview.stdout, /Enable selects: @office/);
    for (const args of [
        ['target', 'clean'], ['target', 'clean', '--all'], ['target', 'clean', 'example.com'],
        ['global', 'clean'], ['global', 'clean', '--keep', 'local'],
        ['target', 'clean', 'example.com', '--global', 'missing'],
        ['target', 'clean', '--dry-run'],
        ['target', 'clean', 'example.com', '--global', 'local', '--global', 'office'],
        ['target', 'clean', 'example.com', '--global', 'local', '--keep', 'example.net=foo'],
        ['global', 'clean', '--keep', 'local', '--keep', 'office']
    ]) {
        await writeFile(path, fixture());
        /** Incomplete scripts cannot partially mutate any definitions. */
        const result = spawnSync(process.execPath, [entry, '--hosts-file', path, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(await readFile(path, 'utf8'), fixture());
    }
    for (const [args, operation] of [
        [['target', 'clean', 'example.com', '--global', 'local', '--keep', 'example.com=foo'],
            { kind: 'target-clean', group: 'example.com', globalNames: ['local'], keep: ['example.com=foo'] }],
        [['global', 'clean', '--keep', 'office', '--keep', 'six'],
            { kind: 'global-clean', keep: ['office', 'six'] }],
        [['migrate', '--all', '--global', 'office'],
            { kind: 'migrate', groups: ['example.test'], globalNames: ['office'] }]
    ]) {
        /** Migration has outside rules; cleanup exercises the pristine managed fixture. */
        const original = fixture() + (operation.kind === 'migrate' ? '192.0.2.1 new.example.test\r\n' : '');
        await writeFile(path, original);
        /** Real CLI must reproduce the pure domain transform exactly. */
        const result = spawnSync(process.execPath, [entry, '--hosts-file', path, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(path, 'utf8'), transform(original, operation));
        assert.match(result.stdout, /summary:/);
    }
    /** A clean script invocation with no applicable duplicate definitions must preserve source bytes. */
    const cleaned = await readFile(path, 'utf8');
    /** Migration reused its global and has no remaining candidate rules. */
    const repeated = spawnSync(process.execPath, [entry, '--hosts-file', path, 'migrate', '--all'],
        { encoding: 'utf8' });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(await readFile(path, 'utf8'), cleaned);
    for (const args of [['target', 'clean', '--help'], ['global', 'clean', '--help']]) {
        /** Help never accesses even an explicitly missing source. */
        const result = spawnSync(process.execPath, [entry, '--hosts-file', join(dir, 'missing'), ...args],
            { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /--keep/);
    }
});

test('compiled helper replays cleanup and global migration choices and rejects invalid retention', async t => {
    /** Isolated fixture, request and result files. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-clean-helper-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Helper source remains a disposable custom file. */
    const path = join(dir, 'sample hosts');
    for (const operation of [
        { kind: 'target-clean', group: 'example.com', globalNames: ['office'], keep: ['example.com=foo'] },
        { kind: 'global-clean', keep: ['local', 'six'] },
        { kind: 'migrate', groups: ['example.test'], globalNames: ['office'] }
    ]) {
        await writeFile(path, fixture() + '192.0.2.1 new.example.test\r\n');
        /** Request digest is bound to the same source-derived operation preview. */
        const source = await readSource(path);
        /** Exact result independently recomputed by the compiled helper. */
        const expected = transform(source.text, operation);
        /** Complete versioned helper envelope. */
        const bytes = JSON.stringify({ version: 1, sourcePath: source.path, sourceDigest: source.digest,
            operation, resultDigest: sha256(expected) });
        /** Temporary request path for this operation. */
        const request = join(dir, `${operation.kind}.json`);
        await writeFile(request, bytes);
        await run(process.execPath, [resolve('dist/fs/helper.js'), '--commit-request', request, sha256(bytes)]);
        assert.equal(await readFile(path, 'utf8'), expected);
    }
    await writeFile(path, fixture());
    /** Tampered retention is rejected even with valid envelope and request hashes. */
    const source = await readSource(path);
    /** Invalid caller selection must never bypass source-derived validation. */
    const invalid = JSON.stringify({ version: 1, sourcePath: source.path, sourceDigest: source.digest,
        operation: { kind: 'global-clean', keep: ['missing'] }, resultDigest: source.digest });
    /** Rejected helper request path. */
    const request = join(dir, 'invalid.json');
    await writeFile(request, invalid);
    await assert.rejects(run(process.execPath,
        [resolve('dist/fs/helper.js'), '--commit-request', request, sha256(invalid)]));
    assert.equal(await readFile(path, 'utf8'), fixture());
});

/**
 * Drive a real Inquirer subprocess while asserting the fixture is unchanged at every prompt.
 * @param {object} t Test context owning fixture cleanup.
 * @param {string[]} args CLI arguments.
 * @param {object[]} steps Ordered prompt substrings and input sequences.
 * @param {boolean} cancel Whether cancellation should preserve the complete fixture.
 * @param {string} original Source bytes used by this interactive scenario.
 * @returns {Promise<string>} Resulting fixture bytes.
 */
async function tty(t, args, steps, cancel = false, original = fixture()) {
    /** Each interactive run has independent fixture and preload files. */
    const dir = await mkdtemp(join(tmpdir(), 'hostman-clean-tty-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    /** Disposable source whose bytes are checked before every answer. */
    const path = join(dir, 'sample hosts');
    /** Preload exposes a terminal while keeping input deterministic. */
    const preload = join(dir, 'tty.mjs');
    await writeFile(path, original);
    await writeFile(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    /** Real CLI child uses fixture-only filesystem transactions. */
    const child = spawn(process.execPath,
        ['--import', pathToFileURL(preload).href, entry, '--hosts-file', path, ...args],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    /** Output accumulated for prompt detection. */
    let output = '';
    /** Index of the next response. */
    let index = 0;
    /** Promise serializes asynchronous fixture assertions before providing input. */
    let responses = Promise.resolve();
    /** Exit promise installed before input is delivered. */
    const exited = new Promise(resolveExit => child.on('exit', code => resolveExit(code)));
    /** Bound prevents a missing prompt from hanging the suite. */
    const timer = setTimeout(() => child.kill(), 15000);
    child.stderr.on('data', bytes => {
        output += bytes.toString();
    });
    child.stdout.on('data', bytes => {
        output += bytes.toString();
        if (index < steps.length && output.includes(steps[index].prompt)) {
            /** Current prompt response is reserved before another output chunk arrives. */
            const step = steps[index++];
            output = '';
            responses = responses.then(async () => {
                assert.equal(await readFile(path, 'utf8'), original);
                child.stdin.write(step.keys);
            });
        }
    });
    /** Successful completion or deliberate cancellation must terminate without hanging. */
    const code = await exited;
    clearTimeout(timer);
    await responses;
    assert.equal(index, steps.length, output);
    if (!cancel) {
        assert.equal(code, 0, output);
    }
    /** Final bytes allow exact comparison with domain replay. */
    const result = await readFile(path, 'utf8');
    if (cancel) {
        assert.equal(result, original);
    }
    return result;
}

test('TTY group selection, global/local retention and cancellation finish before writes', async t => {
    /** Group cleanup requires both a global decision and a local duplicate decision. */
    const groupResult = await tty(t, ['target', 'clean'], [
        { prompt: 'Group', keys: '\r' },
        { prompt: 'Global target for 192.0.2.1', keys: '\u001b[B\r' },
        { prompt: 'Target to keep 192.0.2.2', keys: '\u001b[B\r' }
    ]);
    assert.equal(groupResult, transform(fixture(), {
        kind: 'target-clean', group: 'example.com', globalNames: ['office'], keep: ['example.com=foo']
    }));
    /** Global cleanup independently selects one name for each duplicate IP. */
    const globalResult = await tty(t, ['global', 'clean'], [
        { prompt: 'Global target for 192.0.2.1', keys: '\r' },
        { prompt: 'Global target for 2001:db8::1', keys: '\r' }
    ]);
    assert.equal(globalResult, transform(fixture(), { kind: 'global-clean', keep: ['local', 'six'] }));
    for (const [args, steps] of [
        [['target', 'clean'], [{ prompt: 'Group', keys: '\u0003' }]],
        [['target', 'clean', 'example.com'],
            [{ prompt: 'Global target for 192.0.2.1', keys: '\u0003' }]],
        [['target', 'clean', 'example.com', '--global', 'local'],
            [{ prompt: 'Target to keep 192.0.2.2', keys: '\u0003' }]],
        [['global', 'clean'], [{ prompt: 'Global target for 192.0.2.1', keys: '\u0003' }]]
    ]) {
        await tty(t, args, steps, true);
    }
});

test('TTY migration chooses matching globals without asking for literal names and cancels without writing', async t => {
    /** Only a globally matching destination is imported, so no local naming prompt is needed. */
    const original = fixture() + '192.0.2.1 new.example.test\r\n';
    /** Global prompt uses existing names rather than creating another literal destination. */
    const result = await tty(t, ['migrate', '--all'], [
        { prompt: 'Global target for 192.0.2.1', keys: '\u001b[B\r' }
    ], false, original);
    assert.equal(result, transform(original, {
        kind: 'migrate', groups: ['example.test'], globalNames: ['office']
    }));
    await tty(t, ['migrate', '--all'], [
        { prompt: 'Global target for 192.0.2.1', keys: '\u0003' }
    ], true, original);
    /** A unique IPv6 global can be imported without any interactive naming or selection prompt. */
    const unique = fixture() + '#192.0.2.9 new.example.test\r\n';
    assert.equal(await tty(t, ['migrate', '--all'], [], false, unique),
        transform(unique, { kind: 'migrate', groups: ['example.test'] }));
});
