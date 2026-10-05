import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    parse, serialize, candidates
} from '#hostman/hosts/document';
import {
    groupDigest, ipKey, validate, resolveTarget
} from '#hostman/domain/model';
import { transform, applyOperation } from '#hostman/domain/operations';
const group = (name = 'foo.test', ip = '10.20.0.10') => ({
    name,
    enabled: true,
    activeTarget: 'lab',
    targets: [
        {
            name: 'lab',
            ip
        },
        {
            name: 'prod',
            ip: '10.30.0.10'
        }
    ],
    hosts: [name, `api.${name}`]
});
const managed = (groups = [group()], globals = []) => serialize(parse('127.0.0.1 localhost\n'),
    {
        version: 1,
        groups,
        globals
    });
const op = (text, operation) => transform(text,
    operation);
test('direct global selections support empty targets, same names and stable switching', () => {
    /** Local and global destinations deliberately share a name. */
    const local = group();
    /** Shared IP is distinct from the group-owned lab destination. */
    const globals = [{ name: 'lab', ip: '127.0.0.1' }];
    /** Clean source before choosing a direct global. */
    const original = managed([local], globals);
    /** Switching changes only the selection and effective rules. */
    const switched = op(original, { kind: 'use', group: local.name, target: '@lab' });
    /** Parsed representation retains literal targets without introducing references. */
    const parsed = parse(switched);
    assert.equal(parsed.groups[0].status, 'CLEAN');
    assert.equal(parsed.document.groups[0].activeTarget, '@lab');
    assert.deepEqual(parsed.document.groups[0].targets, local.targets);
    assert.equal(resolveTarget(parsed.document, parsed.document.groups[0]), '127.0.0.1');
    assert.equal(op(switched, { kind: 'use', group: local.name, target: '@lab' }), switched);
    assert.equal(op(switched, { kind: 'use', group: local.name, target: 'lab' }), original);
    for (const target of ['@missing', '@', '@bad.name', 'missing']) {
        assert.throws(() => op(original, { kind: 'use', group: local.name, target }));
    }
    /** A group may have only a direct shared destination. */
    const sharedOnly = { ...local, activeTarget: '@lab', targets: [] };
    assert.equal(parse(managed([sharedOnly], globals)).groups[0].status, 'CLEAN');
    assert.deepEqual(validate({ version: 1, groups: [sharedOnly], globals }), []);
    assert.throws(() => op(switched, {
        kind: 'target-set', group: local.name, target: { name: 'lab', ip: '@lab' }
    }), /Invalid IP/);
});

test('direct globals protect disabled selections and isolate conflicted consumers', () => {
    /** Disabled selections still prevent deletion of the shared definition. */
    const disabled = { ...group(), enabled: false, activeTarget: '@shared', targets: [] };
    /** Shared destination used by the disabled group. */
    const globals = [{ name: 'shared', ip: '127.0.0.1' }];
    /** Source with no effective managed mappings. */
    const source = managed([disabled], globals);
    assert.throws(() => op(source, { kind: 'global-remove', name: 'shared' }), /foo.test/);
    /** Updating the global preserves the disabled group block byte for byte. */
    const updated = op(source, { kind: 'global-set', name: 'shared', ip: '127.0.0.2' });
    assert.equal(parse(updated).document.groups[0].enabled, false);
    assert.match(op(updated, { kind: 'enable', group: disabled.name }), /127.0.0.2 foo.test/);
    /** Active global consumers participate in pre-mutation conflict checks. */
    const conflicted = op(source, { kind: 'enable', group: disabled.name })
        .replace('127.0.0.1 foo.test', '192.0.2.9 foo.test');
    assert.throws(() => op(conflicted, {
        kind: 'global-set', name: 'shared', ip: '127.0.0.2'
    }), /Conflicted scope/);
    /** Restoring configured mappings does not change the shared definition. */
    const restored = op(conflicted, { kind: 'repair', group: disabled.name, strategy: 'restore' });
    assert.equal(parse(restored).groups[0].status, 'CLEAN');
    assert.throws(() => op(restored, {
        kind: 'repair', group: disabled.name, strategy: 'keep', ip: '127.0.0.1'
    }), /group-owned active target/);
});
test('canonical parse/serialize is stable and all groups are clean',
    () => {
        const text = managed();
        const parsed = parse(text);
        assert.equal(parsed.conflicts.length,
            0);
        assert.equal(parsed.groups[0].status,
            'CLEAN');
        assert.equal(serialize(parsed,
            parsed.document),
        text);
        assert.equal(serialize(parse(serialize(parsed,
            parsed.document)),
        parsed.document),
        text);
    });
test('digest ignores target and hostname ordering',
    () => {
        const g = group();
        assert.equal(groupDigest(g),
            groupDigest({
                ...g,
                targets: [...g.targets].reverse(),
                hosts: [...g.hosts].reverse()
            }));
    });
test('manual valid hostname is dirty and survives a touched mutation',
    () => {
        const text = managed().replace('# <<< group',
            '10.20.0.10 new.foo.test\n# <<< group');
        assert.equal(parse(text).groups[0].status,
            'DIRTY');
        const result = op(text,
            {
                kind: 'use',
                group: 'foo.test',
                target: 'prod'
            });
        assert.ok(result.includes('10.30.0.10 new.foo.test'));
        assert.equal(parse(result).groups[0].status,
            'CLEAN');
    });
for (const [
    name,
    edit,
    type
] of [
        [
            'effective mismatch',
            s => s.replace('10.20.0.10 foo.test',
                '10.99.0.1 foo.test'),
            'EffectiveIpConflict'
        ],
        [
            'missing active target',
            s => s.replace('active=lab',
                'active=unknown'),
            'MissingTargetConflict'
        ],
        [
            'missing global',
            s => s.replace('active=lab', 'active=@missing'),
            'MissingGlobalTargetConflict'
        ],
        [
            'duplicate hostname',
            s => s.replace('# <<< group',
                '10.20.0.10 foo.test\n# <<< group'),
            'DuplicateHostnameConflict'
        ],
        [
            'unmanaged collision',
            s => `10.20.0.10 foo.test\n${s}`,
            'UnmanagedHostnameConflict'
        ],
        [
            'invalid group hostname',
            s => s.replace('10.20.0.10 api.foo.test',
                '10.20.0.10 api.bar.test'),
            'InvalidGroupHostnameConflict'
        ],
        [
            'invalid IP',
            s => s.replace('# target lab=10.20.0.10',
                '# target lab=999.0.0.1'),
            'InvalidIpConflict'
        ],
    ]) {
    test(name,
        () => {
            const text = edit(managed()), parsed = parse(text);
            assert.ok(parsed.conflicts.some(c => c.type === type));
            assert.equal(parsed.groups[0].status,
                'CONFLICT');
            assert.throws(() => op(text,
                {
                    kind: 'disable',
                    group: 'foo.test'
                }));
        });
}
for (const text of [
    '# >>> hostman v2\n',
    '# <<< hostman\n',
    '# >>> hostman v1\n',
    '# >>> hostman v1\n# >>> hostman v1\n# <<< hostman\n',
    '# >>> hostman v1\n# <<< group foo.test\n# <<< hostman\n'
]) {
    test(`fatal marker: ${JSON.stringify(text)}`,
        () => {
            assert.equal(parse(text).documentFatal,
                true);
            assert.throws(() => op(text,
                { kind: 'init' }));
        });
}
test('disable retains definitions and enable restores effective entries',
    () => {
        const disabled = op(managed(),
            {
                kind: 'disable',
                group: 'foo.test'
            });
        assert.ok(disabled.includes('# host foo.test'));
        assert.equal(parse(disabled).groups[0].effective.length,
            0);
        assert.equal(op(disabled,
            {
                kind: 'enable',
                group: 'foo.test'
            }),
        managed());
        assert.equal(op(disabled,
            {
                kind: 'disable',
                group: 'foo.test'
            }),
        disabled);
    });
test('global updates affect only enabled groups directly selecting that global',
    () => {
        const a = group(), b = group('bar.test'), c = group('old.test');
        a.activeTarget = c.activeTarget = '@local';
        c.enabled = false;
        const text = managed([
            a,
            b,
            c
        ],
        [
            {
                name: 'local',
                ip: '127.0.0.1'
            }
        ]);
        const result = op(text,
            {
                kind: 'global-set',
                name: 'local',
                ip: '127.0.0.2'
            });
        assert.ok(result.includes('127.0.0.2 foo.test'));
        for (const name of ['bar.test', 'old.test']) {
            const old = parse(text).groups.find(g => g.group.name === name);
            const next = parse(result).groups.find(g => g.group.name === name);
            assert.equal(text.slice(old.start,
                old.end),
            result.slice(next.start,
                next.end));
        }
        assert.throws(() => op(result,
            {
                kind: 'global-remove',
                name: 'local'
            }),
        /selected/);
    });
test('pure operations never mutate their input and reject invalid targets',
    () => {
        const document = parse(managed()).document, copy = structuredClone(document);
        applyOperation(document,
            {
                kind: 'use',
                group: 'foo.test',
                target: 'prod'
            });
        assert.deepEqual(document,
            copy);
        assert.throws(() => applyOperation(document,
            {
                kind: 'target-remove',
                group: 'foo.test',
                target: 'lab'
            }),
        /active/);
        assert.throws(() => applyOperation(document,
            {
                kind: 'target-add',
                group: 'foo.test',
                target: {
                    name: 'bad',
                    ip: '@missing'
                }
            }));
        assert.throws(() => op(managed(),
            {
                kind: 'add-host',
                group: 'foo.test',
                host: 'bar.test'
            }));
    });
test('conflicted groups can be isolated without blocking valid groups',
    () => {
        const text = managed([group(), group('bar.test')]).replace('10.20.0.10 foo.test',
            '10.9.9.9 foo.test');
        const result = op(text,
            {
                kind: 'disable',
                group: 'bar.test'
            });
        const original = parse(text).groups[0], next = parse(result).groups[0];
        assert.equal(text.slice(original.start,
            original.end),
        result.slice(next.start,
            next.end));
    });
test('repair restores target or keeps one effective group-owned IP',
    () => {
        const text = managed().replaceAll('10.20.0.10 foo.test',
            '10.99.0.1 foo.test').replaceAll('10.20.0.10 api.foo.test',
            '10.99.0.1 api.foo.test');
        assert.equal(op(text,
            {
                kind: 'repair',
                group: 'foo.test',
                strategy: 'restore'
            }),
        managed());
        const kept = op(text,
            {
                kind: 'repair',
                group: 'foo.test',
                strategy: 'keep',
                ip: '10.99.0.1'
            });
        assert.ok(kept.includes('# target lab=10.99.0.1'));
        assert.equal(parse(kept).conflicts.length,
            0);
        assert.throws(() => op(text,
            {
                kind: 'repair',
                group: 'foo.test',
                strategy: 'keep',
                ip: '10.99.0.2'
            }));
    });
test('IPv6 comparison is semantic',
    () => {
        assert.equal(ipKey('0:0:0:0:0:0:0:1'),
            ipKey('::1'));
    });
test('init is repeatable, does not import, and preserves dirty valid changes',
    () => {
        const original = '\uFEFF127.0.0.1 localhost\r\n10.0.0.1 api.foo.test';
        const initialized = op(original,
            { kind: 'init' });
        assert.ok(initialized.startsWith(original));
        assert.equal(parse(initialized).document.groups.length,
            0);
        assert.equal(op(initialized,
            { kind: 'init' }),
        initialized);
        const dirty = managed().replace('# <<< group',
            '10.20.0.10 new.foo.test\n# <<< group');
        assert.equal(op(dirty,
            { kind: 'init' }),
        dirty);
    });
test('migration fixture imports selected groups, preserves other rules, and repeats with no diff',
    async () => {
        const original = await readFile(new URL('./fixtures/unmanaged.hosts',
            import.meta.url),
        'utf8');
        const imported = op(original,
            {
                kind: 'migrate',
                groups: ['foo.test']
            });
        assert.ok(imported.includes('10.0.0.1 legacy.internal'));
        assert.ok(imported.includes('# project'));
        assert.equal(parse(imported).document.groups[0].activeTarget,
            'imported');
        assert.equal(op(imported,
            {
                kind: 'migrate',
                groups: []
            }),
        imported);
        assert.equal(op(imported,
            {
                kind: 'migrate',
                groups: ['foo.test']
            }),
        imported);
        const manual = imported + '10.20.0.10 new.foo.test\n';
        const again = op(manual,
            {
                kind: 'migrate',
                groups: ['foo.test']
            });
        assert.ok(parse(again).document.groups[0].hosts.includes('new.foo.test'));
        assert.equal(parse(again).conflicts.length,
            0);
    });
test('partial aliases retain untouched tokens and inline comments',
    () => {
        const text = '10.0.0.1 api.foo.test\tlegacy.internal  # keep\r\n';
        const result = op(text,
            {
                kind: 'migrate',
                groups: ['foo.test']
            });
        assert.ok(result.startsWith('10.0.0.1 \tlegacy.internal  # keep\r\n'));
    });
test('migration retains BOM, CRLF, and final comments without newline',
    () => {
        const text = '\uFEFF10.0.0.1 api.foo.test # hello';
        const result = op(text,
            {
                kind: 'migrate',
                groups: ['foo.test']
            });
        assert.ok(result.startsWith('\uFEFF# hello\n'));
        const crlf = op('\uFEFF10.0.0.1 api.foo.test\r\n',
            {
                kind: 'migrate',
                groups: ['foo.test']
            });
        assert.ok(crlf.startsWith('\uFEFF# >>>'));
        assert.ok(!/(?<!\r)\n/.test(crlf));
    });
for (const [text, reason] of [
    ['10.0.0.1 api.foo.test\n10.0.0.2 www.foo.test\n', 'Multiple'],
    [managed() + '10.0.0.1 new.foo.test\n', 'differs'],
    [
        op(managed(),
            {
                kind: 'disable',
                group: 'foo.test'
            }) + '10.20.0.10 new.foo.test\n',
        'disabled'
    ],
]) {
    test(`migration skip: ${reason}`,
        () => {
            assert.match(candidates(parse(text))[0].reason,
                new RegExp(reason));
            assert.throws(() => op(text,
                {
                    kind: 'migrate',
                    groups: ['foo.test']
                }));
        });
}
test('localhost aliases and single-label rules stay unmanaged',
    () => {
        const text = '127.0.0.1 localhost localhost.localdomain localhost6.localdomain6 router\n::1 ip6-localhost\n';
        assert.deepEqual(candidates(parse(text)),
            []);
    });
test('IPv6 equivalent migration into existing group succeeds',
    () => {
        const text = managed([
            group('foo.test',
                '::1')
        ]) + '0:0:0:0:0:0:0:1 new.foo.test\n';
        assert.equal(candidates(parse(text))[0].reason,
            undefined);
        assert.equal(parse(op(text,
            {
                kind: 'migrate',
                groups: ['foo.test']
            })).conflicts.length,
        0);
    });
test('duplicate groups and targets are validation conflicts',
    () => {
        const g = group();
        g.targets.push(g.targets[0]);
        assert.ok(validate({
            version: 1,
            globals: [],
            groups: [g, g]
        }).some(c => c.type === 'DuplicateGroupConflict'));
    });
