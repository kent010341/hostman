import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../dist/domain/model.js';
import { transform } from '../dist/domain/operations.js';
import { sourcePath, readSource, commit, execute, helper, decode, run } from '../dist/fs/storage.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'hostman-test-')); t.after(() => rm(dir,{ recursive: true,force: true }));
  const path = join(dir,'sample hosts'); await writeFile(path,'127.0.0.1 localhost\r\n');
  const source = await readSource(path), operation = { kind: 'init' };
  const request = { version: 1,sourcePath: source.path,sourceDigest: source.digest,operation,resultDigest: sha256(transform(source.text,operation)) };
  return { dir,path,source,request };
}
test('platform path defaults and relative custom paths', () => {
  assert.equal(sourcePath(undefined,'linux',{}),'/etc/hosts'); assert.equal(sourcePath(undefined,'darwin',{}),'/etc/hosts');
  assert.equal(sourcePath(undefined,'win32',{ SystemRoot: 'D:\\Windows' }),'D:\\Windows\\System32\\drivers\\etc\\hosts');
  assert.throws(() => sourcePath(undefined,'win32',{}),/SystemRoot/);
  assert.equal(sourcePath('sample hosts'),resolve('sample hosts'));
});
test('decoder retains BOM and rejects non UTF-8 bytes', () => { assert.equal(decode(Buffer.from('\uFEFFhello')),'\uFEFFhello'); assert.throws(() => decode(Buffer.from([0xff,0xfe,0x61,0]))); });
test('transaction writes a temporary fixture and preserves metadata', async t => {
  const f = await fixture(t);
  if (process.platform !== 'win32') await chmod(f.path,0o640);
  const before = await stat(f.path);
  let acl;
  if (process.platform === 'win32') acl = await run('powershell.exe',['-NoProfile','-File',resolve('test/acl.ps1'),'-Path',f.path]);
  assert.equal(await commit(f.request),true);
  assert.equal(sha256(await readFile(f.path)),f.request.resultDigest);
  if (acl) assert.equal(await run('powershell.exe',['-NoProfile','-File',resolve('test/acl.ps1'),'-Path',f.path]),acl);
  const after = await stat(f.path); if (process.platform !== 'win32') { assert.equal(after.mode,before.mode); assert.equal(after.uid,before.uid); assert.equal(after.gid,before.gid); }
  assert.deepEqual(await readdir(f.dir),['sample hosts']);
});
test('concurrent modification causes no hostman write', async t => {
  const f = await fixture(t), changed = '127.0.0.1 localhost\n# external edit\n';
  await assert.rejects(commit(f.request,{ beforeCommit: () => writeFile(f.path,changed) }),/changed/);
  assert.equal(await readFile(f.path,'utf8'),changed); assert.deepEqual(await readdir(f.dir),['sample hosts']);
});
test('replacement failure leaves original and cleans temporary files', async t => {
  const f = await fixture(t); await assert.rejects(commit(f.request,{ replace: async () => { throw new Error('replacement failed'); } }),/replacement/);
  assert.equal(await readFile(f.path,'utf8'),f.source.text); assert.deepEqual(await readdir(f.dir),['sample hosts']);
});
test('lock contention rejects commit without removing another writer lock', async t => {
  const f = await fixture(t); await writeFile(`${f.path}.hostman.lock`,''); await assert.rejects(commit(f.request),/Another hostman/);
  assert.equal(await readFile(f.path,'utf8'),f.source.text); assert.ok((await readdir(f.dir)).includes('sample hosts.hostman.lock'));
});
test('helper validates request and approved result', async t => {
  const f = await fixture(t), path = join(f.dir,'request.json'), bytes = JSON.stringify(f.request); await writeFile(path,bytes);
  await assert.rejects(helper(path,'0'.repeat(64)),/request changed/); assert.equal(await readFile(f.path,'utf8'),f.source.text);
  await assert.rejects(commit({ ...f.request,resultDigest: '0'.repeat(64) }),/approved preview/);
  await helper(path,sha256(bytes)); assert.equal(JSON.parse(await readFile(`${path}.result`,'utf8')).ok,true);
});
test('source edited while awaiting elevation is rejected', async t => {
  const f = await fixture(t), denied = async () => { throw Object.assign(new Error('denied'),{ code: 'EACCES' }); };
  await assert.rejects(execute(f.request,{ interactive: true,allowElevation: true,isElevated: async () => false,writer: denied,launch: async (path,hash) => { await writeFile(f.path,'# edit\n'); await helper(path,hash); } }),/changed/);
  assert.equal(await readFile(f.path,'utf8'),'# edit\n');
});
test('launcher exit failure preserves the structured helper error', async t => {
  const f = await fixture(t);
  await assert.rejects(execute(f.request,{ interactive: true,allowElevation: true,isElevated: async () => false,writer: async () => { throw Object.assign(new Error('denied'),{ code: 'EACCES' }); },launch: async (path,hash) => {
    await writeFile(f.path,'# concurrent edit\n');
    try { await helper(path,hash); } catch { throw new Error('Helper exited with code 1'); }
  } }),/Hosts file changed/);
  assert.equal(await readFile(f.path,'utf8'),'# concurrent edit\n');
});
test('UTF-16 and embedded NUL sources are refused without writes', async t => {
  const f = await fixture(t), bytes = Buffer.from([0xff,0xfe,65,0]); await writeFile(f.path,bytes);
  await assert.rejects(readSource(f.path),/encoding/); assert.deepEqual(await readFile(f.path),bytes);
  await writeFile(f.path,'hello\0world'); await assert.rejects(readSource(f.path),/encoding/);
});
for (const [name,interactive,allowElevation,elevated] of [['non-interactive',false,true,false],['no-elevate',true,false,false],['already elevated',true,true,true]]) test(`permission policy: ${name}`, async t => {
  const f = await fixture(t); let launched = false;
  await assert.rejects(execute(f.request,{ interactive,allowElevation,isElevated: async () => elevated,writer: async () => { throw Object.assign(new Error('denied'),{ code: 'EPERM' }); },launch: async () => { launched = true; } }),elevated ? /despite elevated/ : /Administrator/);
  assert.equal(launched,false); assert.equal(await readFile(f.path,'utf8'),f.source.text);
});
test('interactive helper completes and request files are removed', async t => {
  const f = await fixture(t); let requestPath;
  assert.equal(await execute(f.request,{ interactive: true,allowElevation: true,isElevated: async () => false,writer: async () => { throw Object.assign(new Error('denied'),{ code: 'EACCES' }); },launch: async (path,hash) => { requestPath = path; await helper(path,hash); } }),true);
  await assert.rejects(readFile(requestPath)); assert.equal(sha256(await readFile(f.path)),f.request.resultDigest);
});
for (const message of ['UAC cancelled','sudo authentication failed','elevation tool missing']) test(message, async t => {
  const f = await fixture(t); let requestPath;
  await assert.rejects(execute(f.request,{ interactive: true,allowElevation: true,isElevated: async () => false,writer: async () => { throw Object.assign(new Error('denied'),{ code: 'EACCES' }); },launch: async path => { requestPath = path; throw new Error(message); } }),new RegExp(message));
  assert.equal(await readFile(f.path,'utf8'),f.source.text); await assert.rejects(readFile(requestPath));
});
test('writable custom source and no-op commits need no elevation', async t => {
  const f = await fixture(t); const options = { interactive: true,allowElevation: true,launch: async () => { throw new Error('Unexpected elevation'); } };
  assert.equal(await execute(f.request,options),true);
  const after = await readSource(f.path); assert.equal(await execute({ ...f.request,sourceDigest: after.digest,resultDigest: after.digest },options),false);
});
test('Unix symlink resolves destination and retains symlink', { skip: process.platform === 'win32' },async t => {
  const f = await fixture(t), link = join(f.dir,'linked hosts'); await symlink(f.path,link); assert.equal((await readSource(link)).path,f.source.path);
  await commit(f.request); assert.equal(await readFile(link,'utf8'),await readFile(f.path,'utf8'));
});
