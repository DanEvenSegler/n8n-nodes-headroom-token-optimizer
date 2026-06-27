import {
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	NodeOperationError,
	SupplyData,
} from 'n8n-workflow';
import { compress } from 'headroom-ai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';



interface HeadroomMessage {
	role: string;
	content: string;
}

interface HeadroomOptions {
	model: string;
	baseUrl: string;
	apiKey?: string;
	fallback: boolean;
	timeout: number;
	retries: number;
	tokenBudget?: number;
	config?: {
		compressUserMessages?: boolean;
		compressSystemMessages?: boolean;
	};
}

// Helper to determine message role
function getMessageRole(msg: unknown): string {
	if (msg && typeof msg === 'object') {
		const obj = msg as Record<string, unknown>;
		if (typeof obj._getType === 'function') {
			const type = obj._getType();
			if (type === 'ai') return 'assistant';
			if (type === 'system') return 'system';
			if (type === 'tool' || type === 'function') return 'tool';
			if (type === 'human') return 'user';
		}
		if (typeof obj.role === 'string') return obj.role;
		if (typeof obj.type === 'string') {
			const type = obj.type;
			if (type === 'ai') return 'assistant';
			if (type === 'system') return 'system';
			if (type === 'tool' || type === 'function') return 'tool';
			if (type === 'human') return 'user';
		}
		const className = obj.constructor?.name;
		if (className === 'AIMessage') return 'assistant';
		if (className === 'SystemMessage') return 'system';
		if (className === 'ToolMessage' || className === 'FunctionMessage') return 'tool';
		if (className === 'HumanMessage') return 'user';
	}
	return 'user';
}

// Convert LangChain message to Headroom format
function langchainMessageToHeadroom(msg: unknown): HeadroomMessage {
	const role = getMessageRole(msg);
	let content = '';
	if (msg && typeof msg === 'object') {
		const obj = msg as Record<string, unknown>;
		if (typeof obj.content === 'string') {
			content = obj.content;
		} else if (Array.isArray(obj.content)) {
			content = JSON.stringify(obj.content);
		} else if (obj.content !== undefined && obj.content !== null) {
			content = String(obj.content);
		}
	}
	return { role, content };
}

// Convert Headroom message back to LangChain message class
function headroomMessageToLangchain(m: HeadroomMessage, originalMsg?: unknown): unknown {
	if (originalMsg && typeof originalMsg === 'object' && originalMsg.constructor) {
		try {
			const obj = originalMsg as Record<string, unknown>;
			const cloned = new (originalMsg.constructor as new (args: unknown) => Record<string, unknown>)({
				...obj,
				content: m.content,
			});
			if (cloned.content !== m.content) {
				cloned.content = m.content;
			}
			return cloned;
		} catch {
			// Fall through if constructor cloning fails
		}
	}

	try {
		if (m.role === 'system') {
			return new SystemMessage({ content: m.content });
		} else if (m.role === 'assistant') {
			return new AIMessage({ content: m.content });
		} else if (m.role === 'tool') {
			const originalObj = originalMsg as Record<string, unknown> | undefined;
			return new ToolMessage({
				content: m.content,
				tool_call_id: (originalObj?.tool_call_id as string | undefined) ?? 'tool',
			});
		} else {
			return new HumanMessage({ content: m.content });
		}
	} catch {
		return {
			role: m.role,
			content: m.content,
		};
	}
}

// Compress a list of messages
async function compressMessageArray(
	messages: unknown[],
	options: HeadroomOptions,
	stats?: { tokensSaved: number; originalTokens: number; compressedTokens: number }
): Promise<unknown[]> {
	const headroomMessages = messages.map((msg) => langchainMessageToHeadroom(msg));
	// eslint-disable-next-line no-console
	console.log(`[Headroom Middleware] Sending ${headroomMessages.length} messages to Headroom proxy...`);
	const result = (await compress(headroomMessages, { ...options, fallback: false })) as any;
	// eslint-disable-next-line no-console
	console.log(`[Headroom Middleware] Compression completed. Saved ${result.tokensSaved ?? 0} tokens.`);
	if (stats) {
		stats.tokensSaved += result.tokensSaved ?? 0;
		stats.originalTokens += result.tokensBefore ?? 0;
		stats.compressedTokens += result.tokensAfter ?? 0;
	}
	return result.messages.map((m: HeadroomMessage, idx: number) => {
		const originalMsg = messages.find((orig) => getMessageRole(orig) === m.role) || messages[idx];
		return headroomMessageToLangchain(m, originalMsg);
	});
}

// Intercepts input message arguments and compresses them
async function compressInput(
	input: unknown,
	options: HeadroomOptions,
	stats?: { tokensSaved: number; originalTokens: number; compressedTokens: number }
): Promise<unknown> {
	if (typeof input === 'string') {
		// eslint-disable-next-line no-console
		console.log('[Headroom Middleware] Compressing raw string input...');
		const messages = [{ role: 'user', content: input }];
		const result = (await compress(messages, { ...options, fallback: false })) as any;
		// eslint-disable-next-line no-console
		console.log(`[Headroom Middleware] Compression completed. Saved ${result.tokensSaved ?? 0} tokens.`);
		if (stats) {
			stats.tokensSaved += result.tokensSaved ?? 0;
			stats.originalTokens += result.tokensBefore ?? 0;
			stats.compressedTokens += result.tokensAfter ?? 0;
		}
		return result.messages[0]?.content ?? '';
	}

	if (input && typeof input === 'object' && !Array.isArray(input)) {
		const obj = input as Record<string, unknown>;
		if (obj.content !== undefined) {
			// eslint-disable-next-line no-console
			console.log('[Headroom Middleware] Compressing single message object...');
			const messages = [langchainMessageToHeadroom(input)];
			const result = (await compress(messages, { ...options, fallback: false })) as any;
			// eslint-disable-next-line no-console
			console.log(`[Headroom Middleware] Compression completed. Saved ${result.tokensSaved ?? 0} tokens.`);
			if (stats) {
				stats.tokensSaved += result.tokensSaved ?? 0;
				stats.originalTokens += result.tokensBefore ?? 0;
				stats.compressedTokens += result.tokensAfter ?? 0;
			}
			return headroomMessageToLangchain(result.messages[0], input);
		}
		return input;
	}

	if (Array.isArray(input)) {
		const arr = input as unknown[];
		if (arr.length > 0 && Array.isArray(arr[0])) {
			const compressedOuter = [];
			for (const subArr of arr) {
				if (Array.isArray(subArr)) {
					compressedOuter.push(await compressMessageArray(subArr, options, stats));
				}
			}
			return compressedOuter;
		}
		return await compressMessageArray(arr, options, stats);
	}

	return input;
}

export class HeadroomModelMiddleware implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Headroom Model Middleware',
		name: 'headroomModelMiddleware',
		icon: {
			light: 'file:../../icons/headroom-middleware.svg',
			dark: 'file:../../icons/headroom-middleware-dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["model"]}}',
		usableAsTool: true,
		description: 'Intercepts and compresses LLM prompts as middleware. Works best with repetitive content like tool outputs, logs, and conversation history.',
		defaults: {
			name: 'Headroom Model Middleware',
		},
		// @ts-ignore - n8n uses string connection types
		inputs: [
			{
				displayName: 'Model',
				type: 'ai_languageModel',
				required: true,
			},
		],
		// @ts-ignore
		outputs: [
			{
				displayName: 'Model',
				type: 'ai_languageModel',
			},
		],
		properties: [
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
				description: 'Whether to compress user messages (prompts, chat inputs). Headroom protects user messages by default.',
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

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		// eslint-disable-next-line no-console
		console.log('[Headroom Middleware] supplyData called. Retrieving connection model...');
		const node = this.getNode();
		const model = await this.getInputConnectionData('ai_languageModel', 0);

		if (!model) {
			throw new NodeOperationError(node, 'No Chat Model connected to Headroom Model Middleware.');
		}

		const modelSelection = this.getNodeParameter('model', 0, 'gpt-4o') as string;
		const modelNameParam = modelSelection === 'custom'
			? (this.getNodeParameter('customModel', 0, 'gpt-4o') as string)
			: modelSelection;
		const tokenBudget = this.getNodeParameter('tokenBudget', 0, 0) as number;
		const baseUrl = this.getNodeParameter('baseUrl', 0, 'http://localhost:8787') as string;
		const apiKey = this.getNodeParameter('apiKey', 0, '') as string;
		const fallback = this.getNodeParameter('fallback', 0, true) as boolean;
		const compressUserMessages = this.getNodeParameter('compressUserMessages', 0, true) as boolean;
		const compressSystemMessages = this.getNodeParameter('compressSystemMessages', 0, false) as boolean;
		const timeout = this.getNodeParameter('timeout', 0, 30000) as number;
		const retries = this.getNodeParameter('retries', 0, 1) as number;

		const headroomOptions: HeadroomOptions = {
			model: modelNameParam,
			baseUrl,
			fallback,
			timeout,
			retries,
			config: {
				compressUserMessages,
				compressSystemMessages,
			}
		};

		if (tokenBudget > 0) {
			headroomOptions.tokenBudget = tokenBudget;
		}

		if (apiKey) {
			headroomOptions.apiKey = apiKey;
		}

		// Monkey-patch the model methods directly instead of using a Proxy.
		// This preserves the original object identity so n8n can properly track execution.
		const modelObj = model as Record<string, unknown>;

		// Helper to compress args based on method type
		async function compressArgs(
			methodName: string,
			args: unknown[],
			stats: { tokensSaved: number; originalTokens: number; compressedTokens: number },
		): Promise<unknown[]> {
			const modifiedArgs = [...args];
			const isInvokeLike = methodName === 'invoke' || methodName === 'stream' || methodName === '_stream';
			const isBatch = methodName === 'batch';

			if (isInvokeLike) {
				const input = modifiedArgs[0];
				if (input) {
					modifiedArgs[0] = await compressInput(input, headroomOptions, stats);
				}
			} else if (isBatch) {
				const inputs = modifiedArgs[0];
				if (Array.isArray(inputs)) {
					modifiedArgs[0] = await Promise.all(
						inputs.map((inp) => compressInput(inp, headroomOptions, stats)),
					);
				}
			} else {
				// generate, call, _generate
				const messages = modifiedArgs[0];
				if (messages) {
					modifiedArgs[0] = await compressInput(messages, headroomOptions, stats);
				}
			}
			return modifiedArgs;
		}

		// Attach stats to a response object
		function attachStats(response: unknown, stats: { tokensSaved: number; originalTokens: number; compressedTokens: number }) {
			if (response && typeof response === 'object') {
				const res = response as any;
				if (res.response_metadata) {
					res.response_metadata.headroom = { ...stats };
				} else if (res.additional_kwargs) {
					res.additional_kwargs.headroom = { ...stats };
				} else if (res.generations && Array.isArray(res.generations)) {
					for (const genArray of res.generations) {
						if (Array.isArray(genArray)) {
							for (const gen of genArray) {
								if (gen && gen.message) {
									const msg = gen.message;
									if (!msg.response_metadata) {
										msg.response_metadata = {};
									}
									msg.response_metadata.headroom = { ...stats };
								}
							}
						}
					}
				}
			}
		}

		// Methods that return a regular value (Promise)
		const regularMethods = ['generate', 'invoke', 'call', 'batch', '_generate'];
		// Methods that return an AsyncGenerator / AsyncIterable
		const generatorMethods = ['_streamResponseChunks'];
		// 'stream' is a special case — LangChain's BaseChatModel.stream() calls _streamIterator
		// which internally calls _streamResponseChunks. We only wrap _streamResponseChunks.
		// We also wrap _stream if it exists.
		const streamMethods = ['_stream'];

		for (const methodName of regularMethods) {
			const originalMethod = modelObj[methodName];
			if (typeof originalMethod !== 'function') continue;

			modelObj[methodName] = async function (this: unknown, ...args: unknown[]) {
				const stats = { tokensSaved: 0, originalTokens: 0, compressedTokens: 0 };
				let modifiedArgs = args;

				try {
					modifiedArgs = await compressArgs(methodName, args, stats);
				} catch (error) {
					if (fallback) {
						// eslint-disable-next-line no-console
						console.warn(`[Headroom Middleware] Compression failed, falling back: ${(error as Error).message}`);
					} else {
						throw new NodeOperationError(node, `Headroom compression failed: ${(error as Error).message}`);
					}
				}

				const response = await (originalMethod as (...a: unknown[]) => unknown).apply(modelObj, modifiedArgs);
				attachStats(response, stats);
				return response;
			};
		}

		// Wrap generator methods: these must return AsyncGenerator
		for (const methodName of generatorMethods) {
			const originalMethod = modelObj[methodName];
			if (typeof originalMethod !== 'function') continue;

			modelObj[methodName] = async function* (this: unknown, ...args: unknown[]) {
				const stats = { tokensSaved: 0, originalTokens: 0, compressedTokens: 0 };
				let modifiedArgs = args;

				try {
					modifiedArgs = await compressArgs(methodName, args, stats);
				} catch (error) {
					if (fallback) {
						// eslint-disable-next-line no-console
						console.warn(`[Headroom Middleware] Compression failed, falling back: ${(error as Error).message}`);
					} else {
						throw new NodeOperationError(node, `Headroom compression failed: ${(error as Error).message}`);
					}
				}

				const iterator = (originalMethod as (...a: unknown[]) => AsyncIterable<unknown>).apply(modelObj, modifiedArgs);
				let lastChunk: unknown;
				for await (const chunk of iterator) {
					lastChunk = chunk;
					yield chunk;
				}
				attachStats(lastChunk, stats);
			};
		}

		// Wrap _stream: also an async generator
		for (const methodName of streamMethods) {
			const originalMethod = modelObj[methodName];
			if (typeof originalMethod !== 'function') continue;

			modelObj[methodName] = async function* (this: unknown, ...args: unknown[]) {
				const stats = { tokensSaved: 0, originalTokens: 0, compressedTokens: 0 };
				let modifiedArgs = args;

				try {
					modifiedArgs = await compressArgs(methodName, args, stats);
				} catch (error) {
					if (fallback) {
						// eslint-disable-next-line no-console
						console.warn(`[Headroom Middleware] Compression failed, falling back: ${(error as Error).message}`);
					} else {
						throw new NodeOperationError(node, `Headroom compression failed: ${(error as Error).message}`);
					}
				}

				const iterator = (originalMethod as (...a: unknown[]) => AsyncIterable<unknown>).apply(modelObj, modifiedArgs);
				for await (const chunk of iterator) {
					yield chunk;
				}
			};
		}

		return {
			response: model,
		};
	}
}
