import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, candidates, serialize } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';

/**
 * Import the dedicated fixture group and parse the resulting managed document.
 * @param {string} text Source fixture.
 * @param {object[]} targetNames Optional target naming overrides.
 * @returns {object} Parsed transformed document.
 */
function migrate(text, targetNames = []) {
    return parse(transform(text, { kind: 'migrate', groups: ['example.test'], targetNames }));
}

/**
 * Create a managed fixture with optional global targets.
 * @param {object} group Managed group definition.
 * @param {object[]} globals Global target definitions.
 * @returns {string} Serialized source fixture.
 */
function managed(group, globals = []) {
    return serialize(parse('127.0.0.1 localhost\n'), { version: 1, groups: [group], globals });
}

/**
 * Construct a healthy managed fixture for incremental imports.
 * @param {boolean} enabled Whether the group has effective mappings.
 * @returns {object} Fixture group definition.
 */
function group(enabled = true) {
    return {
        name: 'example.test', enabled, activeTarget: 'lab', hosts: ['www.example.test'],
        targets: [{ name: 'lab', source: 'group', ip: '10.11.22.33' }]
    };
}

test('single comment markers import two disabled targets and the hostname union', () => {
    /** All supported comment spacing forms, plus excluded ordinary and double comments. */
    const source = '\uFEFF  #10.12.34.56 www.example.test\r\n'
        + '# 10.12.34.56 iam.example.test\r\n'
        + '#       127.0.0.1 www.example.test\r\n'
        + '\t#\t127.0.0.1 iam.example.test\r\n'
        + '## 192.0.2.1 ignored.example.test\r\n# ordinary comment\r\n';
    /** Parsed source proves commented rules are excluded from effective collision validation. */
    const before = parse(source);
    assert.equal(before.unmanaged.length, 0);
    assert.equal(before.migrationRules.length, 4);
    /** Disabled imported state, with the first target retained for a later enable. */
    const result = migrate(source);
    assert.deepEqual(result.document.groups[0], {
        name: 'example.test', enabled: false, activeTarget: 'imported',
        targets: [
            { name: 'imported', source: 'group', ip: '10.12.34.56' },
            { name: 'imported-2', source: 'group', ip: '127.0.0.1' }
        ],
        hosts: ['iam.example.test', 'www.example.test']
    });
    assert.equal(result.groups[0].effective.length, 0);
    assert.equal(result.groups[0].status, 'CLEAN');
    assert.ok(result.text.startsWith('\uFEFF'));
    assert.ok(!/(?<!\r)\n/.test(result.text));
    assert.ok(result.text.includes('## 192.0.2.1 ignored.example.test\r\n# ordinary comment\r\n'));
    assert.equal(migrate(result.text).text, result.text);
});

test('one effective IP activates all four hosts even when target host sets differ', () => {
    /** The issue example includes repeated hosts across inactive IPs and a separate effective alias. */
    const source = '#10.12.34.56 www.example.test iam.example.test iot.example.test\n'
        + '#127.0.0.1 www.example.test iam.example.test\n10.11.22.33 foo.example.test\n';
    /** Final source must resolve the complete union through the unique effective IP. */
    const result = migrate(source);
    assert.equal(result.document.groups[0].enabled, true);
    assert.equal(result.document.groups[0].activeTarget, 'imported-3');
    assert.equal(result.document.groups[0].targets.length, 3);
    assert.deepEqual(result.document.groups[0].hosts,
        ['foo.example.test', 'iam.example.test', 'iot.example.test', 'www.example.test']);
    assert.ok(result.groups[0].effective.every(r => r.ip === '10.11.22.33'));
    assert.equal(result.conflicts.length, 0);
});

test('same semantic IP and repeated aliases deduplicate while retaining the first IP spelling', () => {
    /** IPv6 representations are semantically identical across effective and commented rules. */
    const source = '#0:0:0:0:0:0:0:1 www.example.test\n::1 www.example.test www.example.test\n';
    /** The unique target retains the first source spelling and becomes active. */
    const result = migrate(source);
    assert.equal(result.document.groups[0].targets.length, 1);
    assert.equal(result.document.groups[0].targets[0].ip, '0:0:0:0:0:0:0:1');
    assert.deepEqual(result.document.groups[0].hosts, ['www.example.test']);
    assert.equal(result.groups[0].status, 'CLEAN');
});

test('multiple effective IPs skip the entire group and identify conflicting source lines', () => {
    /** Disjoint hostname sets still cannot represent per-host active IPs. */
    const source = '192.0.2.1 www.example.test\n192.0.2.2 api.example.test\n';
    assert.match(candidates(parse(source))[0].reason, /Multiple effective/);
    assert.match(candidates(parse(source))[0].reason, /line 1: 192.0.2.1 www.example.test/);
    assert.match(candidates(parse(source))[0].reason, /line 2: 192.0.2.2 api.example.test/);
    assert.throws(() => migrate(source), /Multiple effective/);
});

test('partial commented aliases preserve prefix, whitespace, unselected hosts and inline comments', () => {
    /** Both groups share a commented line; only the fixture group is selected. */
    const source = '\uFEFF  #       127.0.0.1 www.example.test\tother.test  # keep\r\n'
        + '#10.0.0.1 api.example.test # final comment';
    /** Token removal must never accidentally uncomment the remaining mapping. */
    const result = migrate(source);
    assert.ok(result.text.startsWith('\uFEFF  #       127.0.0.1 \tother.test  # keep\r\n'));
    assert.ok(result.text.includes('# final comment\r\n'));
    assert.equal(result.unmanaged.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(migrate(result.text).text, result.text);
});

test('existing enabled groups absorb compatible outside duplicates and add inactive targets', () => {
    /** External duplicates cause only the conflict that this migration is allowed to remove. */
    const source = managed(group()) + '10.11.22.33 www.example.test api.example.test\n'
        + '#192.0.2.2 www.example.test iot.example.test\n';
    assert.ok(parse(source).conflicts.some(c => c.type === 'UnmanagedHostnameConflict'));
    assert.equal(candidates(parse(source))[0].reason, undefined);
    /** Existing active selection survives while all outside aliases are absorbed. */
    const result = migrate(source);
    assert.equal(result.document.groups[0].activeTarget, 'lab');
    assert.equal(result.document.groups[0].enabled, true);
    assert.deepEqual(result.document.groups[0].hosts,
        ['api.example.test', 'iot.example.test', 'www.example.test']);
    assert.equal(result.document.groups[0].targets.length, 2);
    assert.equal(result.conflicts.length, 0);
});

test('existing disabled groups accept only commented proposals without enabling', () => {
    /** A healthy disabled group can absorb inactive targets and hosts. */
    const source = managed(group(false));
    /** Compatible inactive import preserves the preselected target. */
    const result = migrate(source + '#192.0.2.2 api.example.test\n');
    assert.equal(result.document.groups[0].enabled, false);
    assert.equal(result.document.groups[0].activeTarget, 'lab');
    assert.equal(result.groups[0].effective.length, 0);
    assert.throws(() => migrate(source + '10.11.22.33 api.example.test\n'), /disabled/);
});

test('mismatched effective rules report outside content and managed active IP', () => {
    assert.throws(() => migrate(managed(group()) + '192.0.2.2 api.example.test\n'),
        /managed active IP 10.11.22.33.*line \d+: 192.0.2.2 api.example.test/);
});

test('managed conflicts remain blocking even when an outside duplicate could be absorbed', () => {
    /** Managed effective IP disagreement cannot be repaired implicitly by migration. */
    const source = managed(group()).replace('10.11.22.33 www.example.test', '192.0.2.1 www.example.test')
        + '10.11.22.33 www.example.test\n';
    assert.throws(() => migrate(source), /Existing group is conflicted/);
    assert.throws(() => migrate('# >>> hostman v1\n#127.0.0.1 www.example.test\n'), /Unclosed/);
});

test('global references and active target precedence are preserved when reusing an IP', () => {
    /** Two existing targets resolve to the same IP, with the active reference taking precedence. */
    const existing = group();
    existing.targets = [
        { name: 'literal', source: 'group', ip: '10.11.22.33' },
        { name: 'lab', source: 'global', globalName: 'shared' }
    ];
    /** Candidate identifies the active global reference rather than introducing another target. */
    const source = managed(existing, [{ name: 'shared', ip: '10.11.22.33' }])
        + '#10.11.22.33 api.example.test\n';
    assert.equal(candidates(parse(source))[0].targets[0].name, 'lab');
    assert.deepEqual(migrate(source).document.groups[0].targets,
        [...existing.targets].sort((a, b) => a.name.localeCompare(b.name, 'en')));
});

test('custom names select the same active IP and defaults avoid existing and accepted names', () => {
    /** Naming an earlier target imported-2 forces the next default to use the available imported name. */
    const result = migrate('#192.0.2.1 www.example.test\n127.0.0.1 api.example.test\n',
        [{ group: 'example.test', ip: '192.0.2.1', name: 'imported-2' }]);
    assert.deepEqual(result.document.groups[0].targets.map(t => t.name), ['imported', 'imported-2']);
    assert.equal(result.document.groups[0].activeTarget, 'imported');
    /** Existing imported names must also be reserved even when absent from the candidate IPs. */
    const existing = group();
    existing.targets.push({ name: 'imported', source: 'group', ip: '192.0.2.9' });
    assert.equal(migrate(managed(existing) + '#192.0.2.8 api.example.test\n')
        .document.groups[0].targets.find(t => t.ip === '192.0.2.8').name, 'imported-2');
});

for (const targetNames of [
    [{ group: 'example.test', ip: '127.0.0.1', name: 'bad name' }],
    [{ group: 'other.test', ip: '127.0.0.1', name: 'local' }],
    [{ group: 'example.test', ip: '192.0.2.9', name: 'local' }],
    [{ group: 'example.test', ip: '127.0.0.1', name: 'local' },
        { group: 'example.test', ip: '127.0.0.1', name: 'again' }],
    [{ group: 'example.test', ip: '127.0.0.1', name: 'local' },
        { group: 'example.test', ip: '192.0.2.1', name: 'local' }],
    [null],
    'invalid'
]) {
    test(`untrusted migration naming payload is rejected: ${JSON.stringify(targetNames)}`, () => {
        assert.throws(() => migrate('#127.0.0.1 www.example.test\n#192.0.2.1 api.example.test\n', targetNames),
            /migration target name/);
    });
}
