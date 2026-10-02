import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'coverage/**'
        ]
    },
    {
        files: ['**/*.{js,mjs,ts}'],
        extends: [js.configs.recommended],
        languageOptions: { globals: globals.node },
        plugins: { '@stylistic': stylistic },
        rules: {
            curly: ['error', 'all'],
            'max-statements-per-line': ['error', { max: 1 }],
            '@stylistic/indent': [
                'error',
                4,
                { SwitchCase: 1 }
            ],
            '@stylistic/max-len': [
                'error',
                {
                    code: 120,
                    tabWidth: 4
                }
            ],
            '@stylistic/brace-style': [
                'error',
                '1tbs',
                { allowSingleLine: false }
            ],
            '@stylistic/no-trailing-spaces': 'error',
        },
    },
    {
        files: ['src/**/*.ts'],
        extends: [tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': ['error', { fixToUnknown: true }],
        },
    },
);
