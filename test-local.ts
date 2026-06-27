// Intercept require('headroom-ai') to return our mock implementation
const headroomKey = require.resolve('headroom-ai');
require.cache[headroomKey] = {
	id: headroomKey,
	filename: headroomKey,
	loaded: true,
	exports: {
		compress: async (messages: any[], options: any) => {
			console.log('[Mock headroom-ai.compress] compressing:', JSON.stringify(messages));
			console.log('[Mock headroom-ai.compress] options:', JSON.stringify(options));
			const compressed = messages.map(m => ({
				role: m.role,
				content: m.content.replace(/[aeiouAEIOU]/g, '')
			}));
			return {
				messages: compressed,
				tokensSaved: 10,
				originalTokens: 20,
				compressedTokens: 10
			};
		}
	}
} as any;

import { HeadroomModelMiddleware } from './nodes/HeadroomModelMiddleware/HeadroomModelMiddleware.node';
import { HeadroomTokenOptimizer } from './nodes/HeadroomTokenOptimizer/HeadroomTokenOptimizer.node';
import { isChatInstance } from '@n8n/ai-utilities';

// A mock message mimicking a LangChain HumanMessage
class MockHumanMessage {
	content: string;
	constructor(fields: { content: string }) {
		this.content = fields.content;
	}
	_getType() {
		return 'human';
	}
}

// A mock message mimicking a LangChain AIMessage
class MockAIMessage {
	content: string;
	constructor(fields: { content: string }) {
		this.content = fields.content;
	}
	_getType() {
		return 'ai';
	}
}

// Mock of LangChain Chat Model
class MockChatModel {
	lc_namespace = ['langchain', 'chat_models', 'mock'];
	
	bindTools(tools: any) {
		console.log('[MockChatModel.bindTools] called with tools:', JSON.stringify(tools));
		return this;
	}
	
	async invoke(input: any) {
		console.log('[MockChatModel.invoke] received:', JSON.stringify(input));
		return { content: 'Mocked output response' };
	}
	
	async generate(messages: any[]) {
		console.log('[MockChatModel.generate] received:', JSON.stringify(messages));
		return {
			generations: [[{ text: 'Mocked output generation' }]]
		};
	}
}

async function runTests() {
	console.log('--- Testing HeadroomModelMiddleware ---');
	
	// Create middleware instance
	const middleware = new HeadroomModelMiddleware();
	
	// Mock supplyData context
	const context: any = {
		getInputConnectionData: async () => {
			return new MockChatModel();
		},
		getNodeParameter: (name: string, index: number, fallbackVal?: any) => {
			if (name === 'model') return 'gpt-4o';
			if (name === 'baseUrl') return 'http://localhost:8787';
			if (name === 'fallback') return true;
			return fallbackVal;
		},
		getNode: () => ({})
	};
	
	const supplyResult = await middleware.supplyData.call(context);
	const wrappedModel = supplyResult.response as any;
	
	console.log('Validation checks:');
	console.log('isChatInstance(wrappedModel) should be true:', isChatInstance(wrappedModel));
	console.log('wrappedModel.bindTools should be defined:', typeof wrappedModel.bindTools);
	
	console.log('\n1. Testing invoke() with string input:');
	const responseInvokeStr = await wrappedModel.invoke('Hello World');
	console.log('Invoke String response:', responseInvokeStr);
	
	console.log('\n2. Testing invoke() with LangChain message list:');
	const messages = [
		new MockHumanMessage({ content: 'Explain quantum computing simply' }),
		new MockAIMessage({ content: 'It is computing using quantum bits' }),
		new MockHumanMessage({ content: 'Give me an example' })
	];
	const responseInvokeMsgList = await wrappedModel.invoke(messages);
	console.log('Invoke Message List response:', responseInvokeMsgList);

	console.log('\n3. Testing generate() with message list:');
	const responseGenerate = await wrappedModel.generate(messages);
	console.log('Generate response:', responseGenerate);
	
	console.log('\n--- Testing HeadroomTokenOptimizer ---');
	const optimizer = new HeadroomTokenOptimizer();
	const optimizerContext: any = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, index: number, fallbackVal?: any) => {
			if (name === 'mode') return 'text';
			if (name === 'inputText') return 'Here is some long context text to compress';
			if (name === 'model') return 'gpt-4o';
			if (name === 'baseUrl') return 'http://localhost:8787';
			return fallbackVal;
		},
		continueOnFail: () => false,
		getNode: () => ({})
	};
	
	const executeResult = await optimizer.execute.call(optimizerContext);
	console.log('Optimizer Output:', JSON.stringify(executeResult, null, 2));
}

// Run the tests
runTests().catch(err => {
	console.error('Test run failed:', err);
	process.exit(1);
});
