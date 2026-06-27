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
async function compressMessageArray(messages: unknown[], options: HeadroomOptions): Promise<unknown[]> {
	const headroomMessages = messages.map((msg) => langchainMessageToHeadroom(msg));
	const result = await compress(headroomMessages, options);
	return result.messages.map((m: HeadroomMessage, idx: number) => {
		const originalMsg = messages.find((orig) => getMessageRole(orig) === m.role) || messages[idx];
		return headroomMessageToLangchain(m, originalMsg);
	});
}

// Intercepts input message arguments and compresses them
async function compressInput(input: unknown, options: HeadroomOptions): Promise<unknown> {
	if (typeof input === 'string') {
		const messages = [{ role: 'user', content: input }];
		const result = await compress(messages, options);
		return result.messages[0]?.content ?? '';
	}

	if (input && typeof input === 'object' && !Array.isArray(input)) {
		const obj = input as Record<string, unknown>;
		if (obj.content !== undefined) {
			const messages = [langchainMessageToHeadroom(input)];
			const result = await compress(messages, options);
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
					compressedOuter.push(await compressMessageArray(subArr, options));
				}
			}
			return compressedOuter;
		}
		return await compressMessageArray(arr, options);
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
		description: 'Intercepts and compresses LLM prompts as middleware',
		defaults: {
			name: 'Headroom Model Middleware',
		},
		inputs: [
			{
				displayName: 'Model',
				type: 'ai_languageModel',
				required: true,
			},
		],
		outputs: [
			{
				displayName: 'Model',
				type: 'ai_languageModel',
			},
		],
		properties: [
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

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		const node = this.getNode();
		const model = await this.getInputConnectionData('ai_languageModel', 0);

		if (!model) {
			throw new NodeOperationError(node, 'No Chat Model connected to Headroom Model Middleware.');
		}

		const modelNameParam = this.getNodeParameter('model', 0, 'gpt-4o') as string;
		const baseUrl = this.getNodeParameter('baseUrl', 0, 'http://localhost:8787') as string;
		const apiKey = this.getNodeParameter('apiKey', 0, '') as string;
		const fallback = this.getNodeParameter('fallback', 0, true) as boolean;
		const timeout = this.getNodeParameter('timeout', 0, 30000) as number;
		const retries = this.getNodeParameter('retries', 0, 1) as number;

		const headroomOptions: HeadroomOptions = {
			model: modelNameParam,
			baseUrl,
			fallback,
			timeout,
			retries,
		};

		if (apiKey) {
			headroomOptions.apiKey = apiKey;
		}

		// Create a proxy wrapper around the LangChain Model object to intercept execute calls
		const wrappedModel = new Proxy(model as object, {
			get(target, prop, receiver) {
				if (prop === 'generate' || prop === 'invoke' || prop === 'call') {
					const originalMethod = Reflect.get(target, prop);
					if (typeof originalMethod === 'function') {
						return async function (this: unknown, ...args: unknown[]) {
							const originalArgs = [...args];
							try {
								if (prop === 'invoke') {
									const input = originalArgs[0];
									if (input) {
										originalArgs[0] = await compressInput(input, headroomOptions);
									}
								} else if (prop === 'generate' || prop === 'call') {
									const messages = originalArgs[0];
									if (messages) {
										originalArgs[0] = await compressInput(messages, headroomOptions);
									}
								}
							} catch (error) {
								if (!headroomOptions.fallback) {
									throw new NodeOperationError(node, error as Error);
								}
								// eslint-disable-next-line no-console
								console.error('Headroom compression failed, running fallback:', error);
							}
							return await (originalMethod as (...args: unknown[]) => unknown).apply(target, originalArgs);
						};
					}
				}

				const value = Reflect.get(target, prop, target);
				if (typeof value === 'function' && prop !== 'constructor') {
					if (prop === 'bind' || prop === 'bindTools') {
						return (value as (...args: unknown[]) => unknown).bind(receiver);
					}
					return (value as (...args: unknown[]) => unknown).bind(target);
				}
				return value;
			},
		});

		return {
			response: wrappedModel,
		};
	}
}
