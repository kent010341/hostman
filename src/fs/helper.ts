import { helper } from './storage.js';
if (process.argv.length !== 5 || process.argv[2] !== '--commit-request') {
  console.error('Invalid helper invocation.'); process.exitCode = 1;
} else {
  try { await helper(process.argv[3],process.argv[4]); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
