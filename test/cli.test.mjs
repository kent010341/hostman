import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const entry = resolve('dist/cli/index.js');
function cli(args,env = process.env) { return spawnSync(process.execPath,[entry,...args],{ encoding: 'utf8',env }); }
for (const command of ['', 'init','migrate','show','add','add group','add host','remove','remove group','remove host','enable','disable','use','target','target add','target set','target remove','global','global add','global set','global remove','repair']) test(`help: ${command || 'root'}`, () => {
  const result = cli(['--hosts-file','missing file',...command.split(' ').filter(Boolean),'--help']);
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/Usage:/); assert.match(result.stdout,/Example/); assert.match(result.stdout,/--hosts-file/); assert.equal(result.stderr,'');
});
test('complete CLI lifecycle, dry-run, and repeated migration', async t => {
  const dir = await mkdtemp(join(tmpdir(),'hostman-cli-')); t.after(() => rm(dir,{ recursive: true,force: true })); const path = join(dir,'sample hosts'); await writeFile(path,'10.0.0.1 api.foo.test # comment\n');
  const run = (...args) => { const result = cli(['--hosts-file',path,...args]); assert.equal(result.status,0,result.stderr); return result.stdout; };
  const before = await readFile(path,'utf8'); run('migrate','--dry-run'); assert.equal(await readFile(path,'utf8'),before);
  run('init'); run('init'); run('migrate','--all'); const migrated = await readFile(path,'utf8'); run('migrate','--all'); run('migrate','--group','foo.test'); assert.equal(await readFile(path,'utf8'),migrated);
  run('global','add','local','127.0.0.1'); run('target','add','foo.test','local','@local'); run('use','foo.test','local'); run('add','host','foo.test','@'); run('add','host','foo.test','www');
  run('disable','foo.test'); run('enable','foo.test'); run('global','set','local','127.0.0.2'); assert.match(run('show','foo.test'),/127.0.0.2.*CLEAN/);
  run('use','foo.test','imported'); run('target','remove','foo.test','local'); run('global','remove','local'); run('remove','host','foo.test','www'); run('repair','foo.test','--strategy','restore');
  run('add','group','bar.test','--target','prod=10.1.1.1','--host','@','--disabled'); assert.match(run('show','all'),/bar.test disabled/); run('remove','group','bar.test');
  assert.notEqual(cli(['--hosts-file',path,'use']).status,0); assert.notEqual(cli(['--hosts-file',path,'migrate','--all','--group','foo.test']).status,0);
});
test('no command in a non-interactive process shows help', () => { const result = cli([]); assert.equal(result.status,0); assert.match(result.stdout,/Usage:/); });
