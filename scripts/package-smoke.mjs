import { mkdtemp, rm, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(),'hostman-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run smoke:package.');
function run(executable,args,env = process.env) {
  return new Promise((resolve,reject) => {
    const child = spawn(executable,args,{ env,windowsHide: true,windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(executable),stdio: ['ignore','pipe','pipe'] });
    let output = '',errors = ''; child.stdout.on('data',x => output += x); child.stderr.on('data',x => errors += x);
    child.on('error',reject); child.on('exit',code => code === 0 ? resolve(output) : reject(new Error(errors || output)));
  });
}
const npmRun = args => run(process.execPath,[npm,...args]);
try {
  console.log('Packing the compiled package...');
  await npmRun(['pack','--pack-destination',directory]);
  const tarball = join(directory,'hostman-1.0.0.tgz'), prefix = join(directory,'packed');
  console.log('Installing into a temporary global prefix...');
  await npmRun(['install','--global','--prefix',prefix,'--ignore-scripts','--fetch-retries=0','--fetch-timeout=30000',tarball]);
  const root = process.platform === 'win32' ? join(prefix,'node_modules','hostman') : join(prefix,'lib','node_modules','hostman');
  assert.match(await run(process.execPath,[join(root,'dist','cli','index.js'),'target','set','--help']),/Usage:/);
  await readFile(join(root,'dist','fs','helper.js')); await readFile(join(root,'dist','fs','windows.ps1'));
  const fixture = join(directory,'sample hosts'); await writeFile(fixture,'10.0.0.1 api.foo.test\n');
  await run(process.execPath,[join(root,'dist','cli','index.js'),'--hosts-file',fixture,'migrate','--all']);
  assert.match(await readFile(fixture,'utf8'),/active=imported/);
  const linkPrefix = join(directory,'linked');
  console.log('Linking into a separate temporary prefix...');
  await run(process.execPath,[npm,'link','--ignore-scripts','--package-lock=false'],{ ...process.env,npm_config_prefix: linkPrefix });
  const linkedRoot = process.platform === 'win32' ? join(linkPrefix,'node_modules','hostman') : join(linkPrefix,'lib','node_modules','hostman');
  assert.equal((await realpath(linkedRoot)).toLowerCase(),(await realpath(process.cwd())).toLowerCase());
  assert.match(await run(process.execPath,[join(linkedRoot,'dist','cli','index.js'),'--help']),/Usage:/);
  if (process.platform === 'win32') {
    assert.match(await run(process.env.ComSpec ?? 'cmd.exe',['/d','/s','/c',`""${join(prefix,'hostman.cmd')}" --help"`]),/Usage:/);
    assert.match(await run(process.env.ComSpec ?? 'cmd.exe',['/d','/s','/c',`""${join(linkPrefix,'hostman.cmd')}" --help"`]),/Usage:/);
  } else {
    assert.match(await run(join(prefix,'bin','hostman'),['--help']),/Usage:/);
    assert.match(await run(join(linkPrefix,'bin','hostman'),['--help']),/Usage:/);
  }
  console.log('Packed and linked installations passed, including command shims and packaged helpers.');
} finally { await rm(directory,{ recursive: true,force: true }); }
