import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdtemp, readFile, writeFile, rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '../dist/hosts/document.js';
import { quoteArgument } from '../dist/cli/hints.js';
const entry = resolve('dist/cli/index.js');
function cli(args, env = process.env) {
    return spawnSync(process.execPath,
        [entry, ...args],
        {
            encoding: 'utf8',
            env
        });
}
for (const command of [
    '',
    'init',
    'migrate',
    'show',
    'add',
    'add group',
    'add host',
    'remove',
    'remove group',
    'remove host',
    'enable',
    'disable',
    'use',
    'target',
    'target add',
    'target set',
    'target remove',
    'global',
    'global add',
    'global set',
    'global remove',
    'repair'
]) {
    test(`help: ${command || 'root'}`,
        () => {
            const result = cli([
                '--hosts-file',
                'missing file',
                ...command.split(' ').filter(Boolean),
                '--help'
            ]);
            assert.equal(result.status,
                0,
                result.stderr);
            assert.match(result.stdout,
                /Usage:/);
            assert.match(result.stdout,
                /Example/);
            assert.match(result.stdout,
                /--hosts-file/);
            assert.match(result.stdout, /--no-hints/);
            if (command) {
                assert.match(result.stdout, /Related commands:/);
            }
            assert.equal(result.stderr,
                '');
        });
}
test('complete CLI lifecycle, dry-run, and repeated migration',
    async (t) => {
        const dir = await mkdtemp(join(tmpdir(),
            'hostman-cli-'));
        t.after(() => rm(dir,
            {
                recursive: true,
                force: true
            }));
        const path = join(dir,
            'sample hosts');
        await writeFile(path,
            '10.0.0.1 api.foo.test # comment\n');
        const run = (...args) => {
            const result = cli([
                '--hosts-file',
                path,
                ...args
            ]);
            assert.equal(result.status,
                0,
                result.stderr);
            return result.stdout;
        };
        const before = await readFile(path,
            'utf8');
        run('migrate',
            '--dry-run');
        assert.equal(await readFile(path,
            'utf8'),
        before);
        const initialized = run('init');
        assert.match(initialized, /Hostman initialized\./);
        const repeatedInit = run('init');
        assert.match(repeatedInit, /Hostman is already initialized\./);
        for (const output of [initialized, repeatedInit]) {
            assert.doesNotMatch(output, /Next steps:/);
        }
        run('migrate',
            '--all');
        const migrated = await readFile(path,
            'utf8');
        run('migrate',
            '--all');
        run('migrate',
            '--group',
            'foo.test');
        assert.equal(await readFile(path,
            'utf8'),
        migrated);
        run('global',
            'add',
            'local',
            '127.0.0.1');
        run('target',
            'add',
            'foo.test',
            'local',
            '@local');
        run('use',
            'foo.test',
            'local');
        run('add',
            'host',
            'foo.test',
            '@');
        run('add',
            'host',
            'foo.test',
            'www');
        run('disable',
            'foo.test');
        run('enable',
            'foo.test');
        run('global',
            'set',
            'local',
            '127.0.0.2');
        assert.match(run('show',
            'foo.test'),
        /127.0.0.2.*CLEAN/);
        run('use',
            'foo.test',
            'imported');
        run('target',
            'remove',
            'foo.test',
            'local');
        run('global',
            'remove',
            'local');
        run('remove',
            'host',
            'foo.test',
            'www');
        run('repair',
            'foo.test',
            '--strategy',
            'restore');
        run('add',
            'group',
            'bar.test',
            '--target',
            'prod=10.1.1.1',
            '--host',
            '@',
            '--disabled');
        assert.match(run('show',
            'all'),
        /bar.test disabled/);
        run('remove',
            'group',
            'bar.test');
        assert.notEqual(cli([
            '--hosts-file',
            path,
            'use'
        ]).status,
        0);
        assert.notEqual(cli([
            '--hosts-file',
            path,
            'migrate',
            '--all',
            '--group',
            'foo.test'
        ]).status,
        0);
    });
for (const scenario of [
    { name: 'omitted hosts include the root', args: [], hosts: ['my.dev'], enabled: true },
    { name: 'explicit hosts replace the default', args: ['--host', 'api'], hosts: ['api.my.dev'], enabled: true },
    { name: 'explicit root is included once', args: ['--host', '@'], hosts: ['my.dev'], enabled: true },
    { name: 'disabled groups retain the default root', args: ['--disabled'], hosts: ['my.dev'], enabled: false }
]) {
    test(`add group: ${scenario.name}`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'hostman-add-group-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const path = join(dir, 'sample hosts');
        const original = '127.0.0.1 localhost\n';
        await writeFile(path, original);
        const initialized = cli(['--hosts-file', path, 'init']);
        assert.equal(initialized.status, 0, initialized.stderr);
        const result = cli([
            '--hosts-file', path, 'add', 'group', 'my.dev', '--target', 'me=127.0.0.1', ...scenario.args
        ]);
        assert.equal(result.status, 0, result.stderr);
        const content = await readFile(path, 'utf8');
        assert.ok(content.startsWith(original));
        const parsed = parse(content);
        assert.deepEqual(parsed.conflicts, []);
        assert.equal(parsed.groups.length, 1);
        const managed = parsed.groups[0];
        assert.equal(managed.status, 'CLEAN');
        assert.deepEqual(managed.group.hosts, scenario.hosts);
        assert.equal(managed.group.activeTarget, 'me');
        assert.equal(managed.group.enabled, scenario.enabled);
        assert.deepEqual(managed.effective.flatMap(rule => rule.hosts), scenario.enabled ? scenario.hosts : []);
        for (const rule of managed.effective) {
            assert.equal(rule.ip, '127.0.0.1');
        }
    });
}

test('default group root rejects an unmanaged duplicate without writing', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hostman-add-duplicate-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'sample hosts');
    const original = '10.0.0.1 my.dev # existing mapping\n';
    await writeFile(path, original);
    const initialized = cli(['--hosts-file', path, 'init']);
    assert.equal(initialized.status, 0, initialized.stderr);
    const before = await readFile(path, 'utf8');
    const result = cli(['--hosts-file', path, 'add', 'group', 'my.dev', '--target', 'me=127.0.0.1']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /my\.dev also exists outside hostman/);
    assert.equal(await readFile(path, 'utf8'), before);
});

test('interactive hints retain custom paths, follow state, and respect --no-hints', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'hostman-hints-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "user's $sample hosts");
    const preload = join(dir, 'tty.mjs');
    await writeFile(path, '127.0.0.1 localhost\n');
    await writeFile(preload,
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n"
        + "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
    const run = (...args) => spawnSync(process.execPath,
        ['--import', pathToFileURL(preload).href, entry, '--hosts-file', path, ...args], { encoding: 'utf8' });
    const check = (...args) => {
        const result = run(...args);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    const prefix = `hostman --hosts-file ${quoteArgument(path)}`;
    const initialized = check('init');
    assert.ok(initialized.indexOf('Hostman initialized.') < initialized.indexOf('Next steps:'));
    assert.ok(initialized.includes(`${prefix} add group example.com --target local=127.0.0.1 --host '@'`));
    const before = await readFile(path, 'utf8');
    assert.match(check('init'), /already initialized/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.doesNotMatch(check('--no-hints', 'init'), /Next steps:/);
    const created = check('add', 'group', 'team.test', '--target', 'me=127.0.0.1', '--host', '@');
    assert.ok(created.includes(`${prefix} add host team.test api`));
    assert.ok(created.includes(`${prefix} target add team.test lab 192.0.2.10`));
    const target = check('target', 'add', 'team.test', 'lab', '192.0.2.10');
    assert.ok(target.includes(`${prefix} use team.test lab`));
    assert.doesNotMatch(check('show', 'team.test'), /Next steps:/);
    check('disable', 'team.test');
    const disabled = check('add', 'host', 'team.test', 'api');
    assert.ok(disabled.includes(`${prefix} enable team.test`));
    assert.ok(!disabled.includes(`${prefix} use team.test`));
    const unchanged = await readFile(path, 'utf8');
    const failed = run('target', 'remove', 'team.test', 'me');
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /Inspect available targets before choosing another:/);
    assert.equal(await readFile(path, 'utf8'), unchanged);
    const skipped = check('migrate', '--all');
    assert.match(skipped, /No eligible imports/);
    assert.match(skipped, /enable team.test/);
    check('enable', 'team.test');
    await writeFile(path, (await readFile(path, 'utf8')) + '192.0.2.1 one.test\n192.0.2.2 api.one.test\n');
    assert.match(check('migrate', '--dry-run'), /Resolve the SKIP reasons above/);
});

test('no command in a non-interactive process shows help',
    () => {
        const result = cli([]);
        assert.equal(result.status,
            0);
        assert.match(result.stdout,
            /Usage:/);
    });
