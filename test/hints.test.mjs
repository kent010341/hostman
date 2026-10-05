import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '#hostman/hosts/document';
import { transform } from '#hostman/domain/operations';
import { operationHints, showHints, formatHints, quoteArgument, relatedHints, errorHints } from '#hostman/cli/hints';

function fixture(overrides = {}) {
    const group = {
        name: 'example.com', enabled: true, activeTarget: 'local', hosts: ['example.com'],
        targets: [
            { name: 'local', source: 'group', ip: '127.0.0.1' },
            { name: 'lab', source: 'group', ip: '192.0.2.10' }
        ], ...overrides
    };
    const text = serialize(parse('127.0.0.1 localhost\n'), { version: 1, groups: [group], globals: [] });
    return parse(text);
}

test('creation hints use actual group names and avoid existing hostname and target names', () => {
    const parsed = fixture({ name: 'team.test', hosts: ['team.test', 'api.team.test'] });
    const hints = operationHints({ kind: 'add-group', group: parsed.document.groups[0] }, parsed);
    assert.deepEqual(hints.map(h => h.args), [
        ['add', 'host', 'team.test', 'api-new'],
        ['target', 'add', 'team.test', 'lab-new', '192.0.2.10'],
        ['show', 'team.test']
    ]);
    assert.equal(operationHints({ kind: 'init' }, parsed).length, 3);
});

test('target and hostname suggestions reflect the active target and available alternatives', () => {
    const parsed = fixture();
    const target = parsed.document.groups[0].targets.find(t => t.name === 'lab');
    for (const kind of ['target-add', 'target-set']) {
        assert.deepEqual(operationHints({ kind, group: 'example.com', target }, parsed)[0].args,
            ['use', 'example.com', 'lab']);
        const active = parsed.document.groups[0].targets.find(t => t.name === 'local');
        assert.deepEqual(operationHints({ kind, group: 'example.com', target: active }, parsed).map(h => h.args),
            [['show', 'example.com']]);
    }
    const operation = { kind: 'add-host', group: 'example.com', host: 'api' };
    assert.deepEqual(operationHints(operation, parsed)[1].args, ['use', 'example.com', 'lab']);
    const single = fixture({ targets: parsed.document.groups[0].targets.filter(t => t.name === 'local') });
    assert.deepEqual(operationHints(operation, single).map(h => h.args), [['show', 'example.com']]);
});

test('disabled groups suggest enabling instead of ineffective target switches', () => {
    const parsed = fixture({ enabled: false });
    for (const operation of [
        { kind: 'add-host', group: 'example.com', host: 'api' },
        { kind: 'use', group: 'example.com', target: 'lab' },
        { kind: 'target-add', group: 'example.com', target: parsed.document.groups[0].targets[1] },
        { kind: 'disable', group: 'example.com' },
        { kind: 'add-group', group: parsed.document.groups[0] }
    ]) {
        const hints = operationHints(operation, parsed);
        assert.ok(hints.some(h => h.args[0] === 'enable'));
        assert.ok(hints.every(h => h.args[0] !== 'use'));
        assert.ok(hints.length <= 3);
    }
});

test('migration, removal, repair and enable suggestions point to resulting state', () => {
    const parsed = fixture();
    assert.deepEqual(operationHints({ kind: 'migrate', groups: ['example.com'] }, parsed)[0].args,
        ['show', 'example.com']);
    assert.deepEqual(operationHints({ kind: 'migrate', groups: [] }, parsed)[0].args, ['show', 'all']);
    for (const operation of [
        { kind: 'enable', group: 'example.com' },
        { kind: 'use', group: 'example.com', target: 'local' },
        { kind: 'remove-host', group: 'example.com', host: 'api' },
        { kind: 'target-remove', group: 'example.com', target: 'lab' },
        { kind: 'repair', group: 'example.com', strategy: 'restore' }
    ]) {
        assert.deepEqual(operationHints(operation, parsed).map(h => h.args), [['show', 'example.com']]);
    }
    for (const operation of [
        { kind: 'remove-group', group: 'example.com' },
        { kind: 'global-remove', name: 'shared' }
    ]) {
        assert.deepEqual(operationHints(operation, parsed)[0].args, ['show', 'all']);
    }
});

test('global hints show how to reference the new global and inspect affected groups', () => {
    const parsed = fixture();
    assert.deepEqual(operationHints({ kind: 'global-add', name: 'shared', ip: '127.0.0.1' }, parsed)[0].args,
        ['target', 'add', 'example.com', 'shared', '@shared']);
    const withGlobal = transform(parsed.text, { kind: 'global-add', name: 'shared', ip: '127.0.0.1' });
    const referenced = parse(transform(withGlobal, {
        kind: 'target-add', group: 'example.com', target: { name: 'shared', source: 'global', globalName: 'shared' }
    }));
    assert.deepEqual(operationHints({ kind: 'global-set', name: 'shared', ip: '127.0.0.2' }, referenced)[0].args,
        ['show', 'example.com']);
    const empty = parse(transform('', { kind: 'init' }));
    assert.ok(operationHints({ kind: 'global-add', name: 'shared', ip: '127.0.0.1' }, empty)
        .some(h => h.args[0] === 'add'));
});

test('show only suggests actions for empty, disabled, dirty or conflicted documents', () => {
    assert.deepEqual(showHints(fixture(), ['example.com']), []);
    assert.deepEqual(showHints(parse(''), [])[0].args, ['init']);
    assert.deepEqual(showHints(parse(transform('', { kind: 'init' })), [])[0].args,
        ['add', 'group', 'example.com', '--target', 'local=127.0.0.1', '--host', '@']);
    assert.deepEqual(showHints(fixture({ enabled: false }), [])[0].args, ['enable', 'example.com']);
    assert.deepEqual(showHints(fixture({ hosts: [] }), ['example.com'])[0].args,
        ['add', 'host', 'example.com', '@']);
    const dirty = parse(fixture().text.replace('127.0.0.1 example.com', '127.0.0.1 example.com api.example.com'));
    assert.equal(dirty.groups[0].status, 'DIRTY');
    assert.deepEqual(showHints(dirty, ['example.com'])[0].args, ['repair', 'example.com', '--help']);
    const conflicted = parse(fixture().text.replace('127.0.0.1 example.com', '192.0.2.20 example.com'));
    assert.equal(conflicted.groups[0].status, 'CONFLICT');
    assert.deepEqual(showHints(conflicted, ['example.com'])[0].args, ['repair', 'example.com', '--help']);
});

test('all suggested commands retain quoted custom source paths in PowerShell and Unix shells', () => {
    const path = "C:\\sample hosts\\user's $fixture`file";
    const hints = operationHints({ kind: 'init' }, parse(''));
    for (const platform of ['win32', 'linux']) {
        const output = formatHints(hints, path, platform);
        const commands = output.split('\n').filter(line => line.startsWith('    hostman'));
        assert.equal(commands.length, 4);
        for (const command of commands) {
            const prefix = `    hostman --hosts-file ${quoteArgument(path, platform)}`;
            assert.ok(command === prefix || command.startsWith(`${prefix} `));
        }
        assert.ok(output.includes("--host '@'"));
    }
    assert.equal(quoteArgument("a'b", 'win32'), "'a''b'");
    assert.equal(quoteArgument("a'b", 'linux'), "'a'\\''b'");
    assert.equal(quoteArgument('@shared', 'win32'), "'@shared'");
});

test('help provides related command examples without needing a document', () => {
    for (const key of [
        'init', 'migrate', 'show', 'add', 'add group', 'add host', 'remove', 'remove group', 'remove host',
        'enable', 'disable', 'use', 'target', 'target add', 'target set', 'target remove',
        'global', 'global add', 'global set', 'global remove', 'repair'
    ]) {
        assert.ok(relatedHints(key).length);
    }
});

test('failure hints suggest recovery without claiming success or choosing a repair strategy', () => {
    assert.deepEqual(errorHints('No hostman section. Run hostman init or migrate first.', ['add'])[0].args, ['init']);
    assert.deepEqual(errorHints('example.com also exists outside hostman.', ['add'])[0].args,
        ['migrate', '--dry-run']);
    assert.deepEqual(errorHints('Conflicted scope. Run hostman repair before mutation.', ['add'])[1].args,
        ['repair', '--help']);
    assert.deepEqual(errorHints('Cannot remove the active target. Switch targets first.', ['target'])[1].args,
        ['use', '--help']);
    assert.deepEqual(errorHints('Unknown target.', ['use'])[0].args, ['use', '--help']);
});
