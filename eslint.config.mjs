import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		ignores: ['test-local.ts', 'dist/**/*'],
	},
	{
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
			'@n8n/community-nodes/valid-peer-dependencies': 'off',
			'@typescript-eslint/no-require-imports': 'off',
		},
	},
];
