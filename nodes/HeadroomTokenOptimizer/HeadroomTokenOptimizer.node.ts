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
	tokensBefore?: number;
	tokensAfter?: number;
	tokensSaved?: number;
	compressionRatio?: number;
	transformsApplied?: string[];
	compressed?: boolean;
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
				displayName: 'Tokenizer Model',
				name: 'model',
				type: 'options',
				options: [
					{ name: 'GPT-4o (OpenAI)', value: 'gpt-4o' },
					{ name: 'GPT-4o Mini (OpenAI)', value: 'gpt-4o-mini' },
					{ name: 'GPT-4 Turbo (OpenAI)', value: 'gpt-4-turbo' },
					{ name: 'GPT-4 (OpenAI)', value: 'gpt-4' },
					{ name: 'GPT-3.5 Turbo (OpenAI)', value: 'gpt-3.5-turbo' },
					{ name: 'o1 (OpenAI)', value: 'o1' },
					{ name: 'o1-Mini (OpenAI)', value: 'o1-mini' },
					{ name: 'o3 (OpenAI)', value: 'o3' },
					{ name: 'o3-Mini (OpenAI)', value: 'o3-mini' },
					{ name: 'Claude 3.5 Sonnet (Anthropic)', value: 'claude-3-5-sonnet-20241022' },
					{ name: 'Claude 3.5 Haiku (Anthropic)', value: 'claude-3-5-haiku-20241022' },
					{ name: 'Claude 3 Opus (Anthropic)', value: 'claude-3-opus-20240229' },
					{ name: 'Claude 3 Sonnet (Anthropic)', value: 'claude-3-sonnet-20240229' },
					{ name: 'Claude 3 Haiku (Anthropic)', value: 'claude-3-haiku-20240307' },
					{ name: 'Claude 4 Opus (Anthropic)', value: 'claude-sonnet-4-20250514' },
					{ name: 'Gemini 1.5 Pro (Google)', value: 'gemini/gemini-1.5-pro' },
					{ name: 'Gemini 1.5 Flash (Google)', value: 'gemini/gemini-1.5-flash' },
					{ name: 'Gemini 2.0 Flash (Google)', value: 'gemini/gemini-2.0-flash' },
					{ name: 'Gemini 2.5 Pro (Google)', value: 'gemini/gemini-2.5-pro' },
					{ name: 'Command R+ (Cohere)', value: 'command-r-plus' },
					{ name: 'Command R (Cohere)', value: 'command-r' },
					{ name: 'Mistral Large (Mistral)', value: 'mistral/mistral-large-latest' },
					{ name: 'Mistral Medium (Mistral)', value: 'mistral/mistral-medium-latest' },
					{ name: 'Mistral Small (Mistral)', value: 'mistral/mistral-small-latest' },
					{ name: 'Codestral (Mistral)', value: 'mistral/codestral-latest' },
					{ name: 'Llama 3.1 70B (Meta/Groq)', value: 'groq/llama-3.1-70b-versatile' },
					{ name: 'Llama 3.1 8B (Meta/Groq)', value: 'groq/llama-3.1-8b-instant' },
					{ name: 'DeepSeek Chat (DeepSeek)', value: 'deepseek/deepseek-chat' },
					{ name: 'DeepSeek Coder (DeepSeek)', value: 'deepseek/deepseek-coder' },
					{ name: 'Custom', value: 'custom' },
				],
				default: 'gpt-4o',
				required: true,
				description: 'Tokenizer schema used by Headroom to count tokens. Pick the closest model family — does NOT affect your actual LLM. For Ollama / local models, use GPT-4o.',
			},
			{
				displayName: 'Custom Tokenizer Model',
				name: 'customModel',
				type: 'string',
				displayOptions: {
					show: {
						model: ['custom'],
					},
				},
				default: '',
				required: true,
				placeholder: 'e.g. together_ai/meta-llama/Llama-3-70b',
				description: 'A litellm-compatible model identifier. See https://docs.litellm.ai/docs/providers for the full list.',
			},
			{
				displayName: 'Token Budget',
				name: 'tokenBudget',
				type: 'number',
				default: 0,
				description: 'Enforce compression when prompt size exceeds this token count. Set to 0 to always compress.',
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
				displayName: 'Compress User Messages',
				name: 'compressUserMessages',
				type: 'boolean',
				default: true,
				description: 'Whether to compress user messages (prompts and inputs). Headroom protects user messages by default.',
			},
			{
				displayName: 'Compress System Messages',
				name: 'compressSystemMessages',
				type: 'boolean',
				default: false,
				description: 'Whether to compress system messages (system prompts). Headroom protects system messages by default.',
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
				const modelSelection = this.getNodeParameter('model', i, 'gpt-4o') as string;
				const model = modelSelection === 'custom'
					? (this.getNodeParameter('customModel', i, 'gpt-4o') as string)
					: modelSelection;
				const tokenBudget = this.getNodeParameter('tokenBudget', i, 0) as number;
				const baseUrl = this.getNodeParameter('baseUrl', i, 'http://localhost:8787') as string;
				const apiKey = this.getNodeParameter('apiKey', i, '') as string;
				const fallback = this.getNodeParameter('fallback', i, true) as boolean;
				const compressUserMessages = this.getNodeParameter('compressUserMessages', i, true) as boolean;
				const compressSystemMessages = this.getNodeParameter('compressSystemMessages', i, false) as boolean;
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
					config?: {
						compressUserMessages?: boolean;
						compressSystemMessages?: boolean;
					};
				} = {
					model,
					baseUrl,
					timeout,
					fallback,
					retries,
					config: {
						compressUserMessages,
						compressSystemMessages,
					}
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
						originalTokens: result.tokensBefore ?? 0,
						compressedTokens: result.tokensAfter ?? 0,
						compressionRatio: result.compressionRatio ?? 1,
						transformsApplied: result.transformsApplied ?? [],
					};
				} else if (mode === 'messages') {
					compressedOutput = result.messages;
					responseJson = {
						compressed: compressedOutput,
						tokensSaved: result.tokensSaved ?? 0,
						originalTokens: result.tokensBefore ?? 0,
						compressedTokens: result.tokensAfter ?? 0,
						compressionRatio: result.compressionRatio ?? 1,
						transformsApplied: result.transformsApplied ?? [],
					};
				} else {
					// chatInput mode
					const originalJson = items[i].json;
					compressedOutput = result.messages[0]?.content ?? '';
					responseJson = {
						...originalJson,
						chatInput: compressedOutput,
						tokensSaved: result.tokensSaved ?? 0,
						originalTokens: result.tokensBefore ?? 0,
						compressedTokens: result.tokensAfter ?? 0,
						compressionRatio: result.compressionRatio ?? 1,
						transformsApplied: result.transformsApplied ?? [],
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
