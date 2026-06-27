# n8n-nodes-headroom-token-optimizer

This is an n8n community node plugin that optimizes LLM (Large Language Model) token usage in your workflows using [Headroom](https://github.com/headroomlabs-ai/headroom) context compression. It acts as an optimization layer between your n8n workflow and your LLM providers (e.g., OpenAI, Anthropic, or local Ollama).

---

## Key Features

- **Direct Token Optimizer Node**: A standard node that takes text or messages, compresses them using Headroom's pipeline (removing duplicate logs, redundant code, boilerplate, and long-range text), and outputs the compressed text alongside metrics:
  - `tokensSaved`: Number of tokens avoided.
  - `originalTokens`: Original token count.
  - `compressedTokens`: Optimized token count.
- **Model Middleware Node**: A background wrapper that hooks into n8n's language model connections. It transparently intercepts all LLM calls (supporting `invoke`, `stream`, and `batch` requests) and compresses the prompts in the background before they reach the LLM.
- **Exposed Token Budget**: Define a custom `Token Budget` parameter in both nodes. Compression will be dynamically triggered only when the prompt size exceeds this limit.
- **UI Savings Statistics**: Automatically injects compression metrics (`tokensSaved`, `originalTokens`, `compressedTokens`) into the `response_metadata` of LLM output messages, making headroom savings visible directly in n8n execution history logs.

---

## Prerequisites

To use this plugin, you must have a running Headroom proxy server instance. 

### Quick Start with Docker
Start the Headroom proxy pointing to your LLM endpoint (e.g. Ollama on the host):
```bash
docker run -d --name headroom-proxy \
  -p 8787:8787 \
  -e OPENAI_TARGET_API_URL=http://host.docker.internal:11434/v1 \
  ghcr.io/chopratejas/headroom:latest
```

---

## Installation

### In n8n Admin Panel
1. Go to **Settings** > **Community Nodes**.
2. Click **Install a Node**.
3. Enter `n8n-nodes-headroom-token-optimizer` in the npm package name field.
4. Agree to terms and click **Install**.

---

## Usage Guide

### 1. Direct Token Optimizer Node
Use this node to compress large files, API responses, or logs before feeding them into your LLM prompt.
- **Mode**: Choose between `Text`, `Messages` (JSON array of chat history), or `Chat Input` (to automatically hook into a Chat Trigger's input).
- **Token Budget**: Set a target size (e.g. `2000`). If the input contains more tokens than this budget, Headroom compresses it down.
- **Base URL**: The address of your Headroom proxy (defaults to `http://localhost:8787`).
- **Model**: The model name (used to calculate accurate tokenizer metrics, e.g., `gpt-4o` or `granite4.1:3b`).

### 2. Model Middleware Node
Use this node to wrap your language models transparently.
1. Add a **Headroom Model Middleware** node.
2. Connect it to the `Model Middleware` input of any n8n LLM Node (e.g. **Ollama Chat Model** or **OpenAI Chat Model**).
3. Set your **Token Budget** (e.g., `1000`) and **Base URL**.
4. Now, any agent or chain using that model node will have its prompt automatically compressed in the background.

---

## Local Development & Testing

### Installation
Clone the repository and install dependencies:
```bash
npm install
```

### Build Node Package
Compiles TypeScript files and copies icons:
```bash
npm run build
```

### Run Integration Tests
We provide a local TypeScript integration test script that runs a complete cycle through the middleware, the local Headroom proxy, and a host Ollama instance:
```bash
npx ts-node test-headroom-ollama.ts
```

---

## License

[MIT](LICENSE)
