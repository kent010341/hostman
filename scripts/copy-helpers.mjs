import {
    mkdir, copyFile, chmod
} from 'node:fs/promises';
await mkdir('dist/fs',
    { recursive: true });
await copyFile('src/fs/windows.ps1',
    'dist/fs/windows.ps1');
await chmod('dist/cli/index.js',
    0o755);
