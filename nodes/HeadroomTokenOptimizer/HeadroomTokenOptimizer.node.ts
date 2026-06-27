import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';
import { compress } from 'headroom-ai';

// Native local compression helper for logs and text
function localCompressText(text: string): { compressed: string; originalTokens: number; compressedTokens: number; tokensSaved: number } {
	const estimateTokens = (t: string) => Math.max(1, Math.ceil(t.length / 4));
	const originalTokens = estimateTokens(text);

	// Log cleanup: collapse contiguous duplicate log lines
	const lines = text.split('\n');
	const uniqueLines: string[] = [];
	let lastLine = '';
	let repeatCount = 0;

	const getLogCore = (l: string) => {
		return l
			.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?/, '') // Timestamps
			.replace(/[a-zA-Z0-9_\-]+\.go:\d+/, '') // Go files
			.replace(/[a-zA-Z0-9_\-]+\.py:\d+/, '') // Python files
			.replace(/[a-zA-Z0-9_\-]+\.js:\d+/, '') // JS files
			.replace(/Attempt \d+ of \d+/, 'Attempt X of Y') // Attempts
			.replace(/retrying in \d+m?s/, 'retrying in X ms') // Durations
			.trim();
	};

	for (let line of lines) {
		line = line.trim();
		if (!line) continue;

		const currentCore = getLogCore(line);
		const lastCore = getLogCore(lastLine);

		if (lastLine && currentCore === lastCore) {
			repeatCount++;
		} else {
			if (repeatCount > 0) {
				uniqueLines.push(`[... repeated ${repeatCount} times ...]`);
				repeatCount = 0;
			}
			uniqueLines.push(line);
			lastLine = line;
		}
	}
	if (repeatCount > 0) {
		uniqueLines.push(`[... repeated ${repeatCount} times ...]`);
	}

	let compressed = uniqueLines.join('\n');

	// JSON-like minification
	if (compressed.startsWith('{') && compressed.endsWith('}')) {
		try {
			const parsed = JSON.parse(compressed);
			compressed = JSON.stringify(parsed);
		} catch (e) {}
	}

	// Double spaces cleanup
	compressed = compressed.replace(/[ \t]+/g, ' ');

	const compressedTokens = estimateTokens(compressed);
	const tokensSaved = Math.max(0, originalTokens - compressedTokens);

	return {
		compressed,
		originalTokens,
		compressedTokens,
		tokensSaved,
	};
}

function localCompressMessages(messages: Array<{ role: string; content: string }>): { messages: Array<{ role: string; content: string }>; tokensSaved: number; originalTokens: number; compressedTokens: number } {
	let originalTokens = 0;
	let compressedTokens = 0;

	const compressedMessages = messages.map((msg) => {
		const result = localCompressText(msg.content);
		originalTokens += result.originalTokens;
		compressedTokens += result.compressedTokens;
		return {
			role: msg.role,
			content: result.compressed,
		};
	});

	const tokensSaved = Math.max(0, originalTokens - compressedTokens);

	return {
		messages: compressedMessages,
		tokensSaved,
		originalTokens,
		compressedTokens,
	};
}

interface HeadroomCompressResult {
	messages: Array<{ role: string; content: string }>;
	tokensSaved?: number;
	originalTokens?: number;
	compressedTokens?: number;
}

export class HeadroomTokenOptimizer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Headroom Token Optimizer',
		name: 'headroomTokenOptimizer',
		icon: {
			light: 'file:../../icons/headroom.svg',
			dark: 'file:../../icons/headroom-dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["model"]}}',
		usableAsTool: true,
		description: 'Optimize LLM token usage using local Headroom context compression',
		defaults: {
			name: 'Headroom Token Optimizer',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				options: [
					{
						name: 'Chat Input ($json.chatInput)',
						value: 'chatInput',
						description: 'Automatically compress the incoming chatInput property and output it',
					},
					{
						name: 'Messages (JSON)',
						value: 'messages',
						description: 'Compress a structured array of chat messages (conversation history)',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Compress a raw block of text (e.g. documents, logs, RAG context)',
					},
				],
				default: 'chatInput',
				description: 'Choose whether to compress text, chat messages, or the incoming chatInput',
			},
			{
				displayName: 'Input Text',
				name: 'inputText',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				displayOptions: {
					show: {
						mode: ['text'],
					},
				},
				default: '',
				required: true,
				description: 'The text content to compress',
			},
			{
				displayName: 'Input Messages',
				name: 'inputMessages',
				type: 'json',
				displayOptions: {
					show: {
						mode: ['messages'],
					},
				},
				default: '[]',
				required: true,
				description: 'The JSON array of messages to compress, e.g. [{"role": "user", "content": "..."}]',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'gpt-4o',
				required: true,
				description: 'The LLM model name (used to calculate accurate token counts for compression)',
			},
			{
				displayName: 'Base URL',
				name: 'baseUrl',
				type: 'string',
				default: 'http://localhost:8787',
				required: true,
				description: 'The Base URL of your local Headroom proxy or Headroom API',
			},
			{
				displayName: 'API Key',
				name: 'apiKey',
				type: 'string',
				typeOptions: {
					password: true,
				},
				default: '',
				description: 'Optional API key if using Headroom Cloud instead of a local proxy',
			},
			{
				displayName: 'Fallback on Error',
				name: 'fallback',
				type: 'boolean',
				default: true,
				description: 'Whether to fall back to the uncompressed input if the Headroom proxy is unreachable or returns an error',
			},
			{
				displayName: 'Timeout (Ms)',
				name: 'timeout',
				type: 'number',
				default: 30000,
				description: 'Request timeout in milliseconds',
			},
			{
				displayName: 'Retries',
				name: 'retries',
				type: 'number',
				default: 1,
				description: 'Number of retries for transient failures',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const mode = this.getNodeParameter('mode', i, 'text') as 'text' | 'messages' | 'chatInput';
				const model = this.getNodeParameter('model', i, 'gpt-4o') as string;
				const baseUrl = this.getNodeParameter('baseUrl', i, 'http://localhost:8787') as string;
				const apiKey = this.getNodeParameter('apiKey', i, '') as string;
				const fallback = this.getNodeParameter('fallback', i, true) as boolean;
				const timeout = this.getNodeParameter('timeout', i, 30000) as number;
				const retries = this.getNodeParameter('retries', i, 1) as number;

				let messagesToCompress: Array<{ role: string; content: string }> = [];

				if (mode === 'text') {
					const inputText = this.getNodeParameter('inputText', i, '') as string;
					messagesToCompress = [{ role: 'user', content: inputText }];
				} else if (mode === 'chatInput') {
					const itemJson = items[i].json;
					const chatInput = (itemJson.chatInput ?? '') as string;
					if (!chatInput) {
						throw new NodeOperationError(this.getNode(), 'No "chatInput" property found on incoming item data. Make sure this node is placed after a Chat Trigger node.', { itemIndex: i });
					}
					messagesToCompress = [{ role: 'user', content: chatInput }];
				} else {
					const inputMessages = this.getNodeParameter('inputMessages', i, '[]') as string | Array<{ role: string; content: string }>;
					if (typeof inputMessages === 'string') {
						messagesToCompress = JSON.parse(inputMessages) as Array<{ role: string; content: string }>;
					} else if (Array.isArray(inputMessages)) {
						messagesToCompress = inputMessages;
					} else {
						throw new NodeOperationError(this.getNode(), 'Input Messages must be an array or a JSON array string', { itemIndex: i });
					}
				}

				const options: {
					model: string;
					baseUrl: string;
					timeout: number;
					fallback: boolean;
					retries: number;
					apiKey?: string;
				} = {
					model,
					baseUrl,
					timeout,
					fallback,
					retries,
				};

				if (apiKey) {
					options.apiKey = apiKey;
				}

				let result: HeadroomCompressResult;
				try {
					result = (await compress(messagesToCompress, { ...options, fallback: false })) as unknown as HeadroomCompressResult;
				} catch (error) {
					// eslint-disable-next-line no-console
					console.log('[Headroom Token Optimizer] Proxy unreachable, falling back to native JS context compression...');
					const localResult = localCompressMessages(messagesToCompress);
					result = {
						messages: localResult.messages,
						tokensSaved: localResult.tokensSaved,
						originalTokens: localResult.originalTokens,
						compressedTokens: localResult.compressedTokens,
					};
				}

				let compressedOutput: string | Array<{ role: string; content: string }>;
				let responseJson: IDataObject = {};

				if (mode === 'text') {
					compressedOutput = result.messages[0]?.content ?? '';
					responseJson = {
						compressed: compressedOutput,
						tokensSaved: result.tokensSaved ?? 0,
						originalTokens: result.originalTokens,
						compressedTokens: result.compressedTokens,
					};
				} else if (mode === 'messages') {
					compressedOutput = result.messages;
					responseJson = {
						compressed: compressedOutput,
						tokensSaved: result.tokensSaved ?? 0,
						originalTokens: result.originalTokens,
						compressedTokens: result.compressedTokens,
					};
				} else {
					// chatInput mode
					const originalJson = items[i].json;
					compressedOutput = result.messages[0]?.content ?? '';
					responseJson = {
						...originalJson,
						chatInput: compressedOutput,
						tokensSaved: result.tokensSaved ?? 0,
						originalTokens: result.originalTokens,
						compressedTokens: result.compressedTokens,
					};
				}

				returnData.push({
					json: responseJson,
					pairedItem: {
						item: i,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as Error).message,
						},
						pairedItem: {
							item: i,
						},
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
