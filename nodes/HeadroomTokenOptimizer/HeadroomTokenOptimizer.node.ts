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
				displayName: 'Token Budget',
				name: 'tokenBudget',
				type: 'number',
				default: 0,
				description: 'Enforce compression when prompt size exceeds this token count. Set to 0 to disable.',
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
				const tokenBudget = this.getNodeParameter('tokenBudget', i, 0) as number;
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
					tokenBudget?: number;
				} = {
					model,
					baseUrl,
					timeout,
					fallback,
					retries,
				};

				if (tokenBudget > 0) {
					options.tokenBudget = tokenBudget;
				}

				if (apiKey) {
					options.apiKey = apiKey;
				}

				let result: HeadroomCompressResult;
				try {
					result = (await compress(messagesToCompress, { ...options, fallback: false })) as unknown as HeadroomCompressResult;
				} catch (error) {
					throw new NodeOperationError(this.getNode(), `Headroom proxy is unreachable or returned an error: ${(error as Error).message}`, { itemIndex: i });
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
