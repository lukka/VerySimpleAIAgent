// LLM Configuration and API handling for Node.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const readline = require('readline');
const { estimateTokens, padToVisualWidth } = require('./utils');

const CONFIG_FILE = path.join(__dirname, '.agent-config.json');

class LLMConfig {
    static DEFAULT_CONFIG = {
        provider: 'openai',
        apiKey: '',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4'
    };

    constructor() {
        this.configFile = CONFIG_FILE;
        this.loadConfig();
    }

    // Load configuration from file
    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = fs.readFileSync(CONFIG_FILE, 'utf8');
                const config = JSON.parse(data);
                this.provider = config.provider || LLMConfig.DEFAULT_CONFIG.provider;
                this.apiKey = config.apiKey || LLMConfig.DEFAULT_CONFIG.apiKey;
                this.endpoint = config.endpoint || LLMConfig.DEFAULT_CONFIG.endpoint;
                this.model = config.model || LLMConfig.DEFAULT_CONFIG.model;
            } else {
                Object.assign(this, LLMConfig.DEFAULT_CONFIG);
            }
        } catch (error) {
            console.error('Error loading config:', error.message);
            Object.assign(this, LLMConfig.DEFAULT_CONFIG);
        }
    }

    // Save configuration to file
    saveConfig() {
        try {
            const config = {
                provider: this.provider,
                apiKey: this.apiKey,
                endpoint: this.endpoint,
                model: this.model
            };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        } catch (error) {
            console.error('Error saving config:', error.message);
        }
    }

    // Update configuration
    update({ provider, apiKey, endpoint, model }) {
        if (provider) this.provider = provider;
        if (apiKey) this.apiKey = apiKey;
        if (endpoint) this.endpoint = endpoint;
        if (model) this.model = model;
        this.saveConfig();
    }

    // Check if config is valid
    isValid() {
        return this.apiKey && this.endpoint && this.model;
    }

    // Get preset configurations
    static getPresets() {
        return {
            openai: {
                name: 'OpenAI',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
                defaultModel: 'gpt-4'
            },
            azure: {
                name: 'Azure OpenAI',
                endpoint: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-02-15-preview',
                models: [],
                defaultModel: 'gpt-4'
            },
            anthropic: {
                name: 'Anthropic',
                endpoint: 'https://api.anthropic.com/v1/messages',
                models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
                defaultModel: 'claude-3-5-sonnet-20241022'
            },
            ollama: {
                name: 'Ollama (Local)',
                endpoint: 'http://localhost:11434/api/chat',
                models: ['llama2', 'mistral', 'codellama', 'neural-chat'],
                defaultModel: 'llama2'
            },
            custom: {
                name: 'Custom',
                endpoint: '',
                models: [],
                defaultModel: ''
            }
        };
    }
}

// LLM API Client
class LLMClient {
    constructor(config, ui = null) {
        this.config = config;
        this.ui = ui; // UI interface for readline and activity indicators
    }

    // Shared helper to create colored token visualization
    // Returns an object with visualization lines for display
    createColoredVisualization(tokenCounts) {
        const TOKENS_PER_BLOCK = 50;
        
        // Simplified color support detection
        const supportsColors = !process.env.NO_COLOR && 
            !process.env.NODE_DISABLE_COLORS && 
            (process.env.FORCE_COLOR || process.stdout.isTTY);

        const colors = supportsColors ? {
            reset: '\x1b[0m',
            green: '\x1b[42m',
            blue: '\x1b[44m',
            yellow: '\x1b[43m',
            cyan: '\x1b[46m',
            magenta: '\x1b[45m',
        } : {
            reset: '', green: '', blue: '', yellow: '', cyan: '', magenta: '',
        };

        // Calculate blocks for each category
        const categories = [];
        let totalTokens = 0;
        let totalBlocks = 0;

        for (const { label, tokens, color } of tokenCounts) {
            totalTokens += tokens;
            // Only create blocks if there are tokens (skip if 0)
            const blocks = tokens > 0 ? Math.ceil(tokens / TOKENS_PER_BLOCK) : 0;
            totalBlocks += blocks;
            categories.push({ label, tokens, blocks, color: colors[color] || '' });
        }

        // Build visualization with scaling if needed
        const maxBlocks = 15;
        const shouldTruncate = totalBlocks > maxBlocks;
        let visualization = '';

        if (shouldTruncate) {
            const scale = maxBlocks / totalBlocks;
            for (const cat of categories) {
                // Only show blocks if the category has tokens (skip if 0)
                if (cat.blocks > 0) {
                    const scaledBlocks = Math.max(1, Math.floor(cat.blocks * scale));
                    for (let i = 0; i < scaledBlocks; i++) {
                        visualization += `${cat.color}   ${colors.reset}`;
                    }
                }
            }
        } else {
            for (const cat of categories) {
                for (let i = 0; i < cat.blocks; i++) {
                    visualization += `${cat.color}   ${colors.reset}`;
                }
            }
        }

        // Build label line
        const labelParts = categories.map(cat => 
            `${cat.color}■${colors.reset}${cat.label}:${cat.tokens}`
        );
        
        const line1 = `📊 ${visualization} ${totalTokens} tokens`;
        const line2 = `   ${labelParts.join(' ')}`;

        return { line1, line2 };
    }

    // Helper to print lines with rate limiting
    async printLinesWithDelay(lines, startIdx, count, formatter = null) {
        for (let i = 0; i < count && startIdx + i < lines.length; i++) {
            const line = lines[startIdx + i];
            console.log(formatter ? formatter(line) : line);
            await new Promise(resolve => setTimeout(resolve, 50)); // 50ms per line = 20 lines/second
        }
    }

    // Helper to dump content with truncation (first 50 lines, then ..., then last 10 lines)
    async dumpContent(title, content) {
        const lines = content.split('\n');
        const totalLines = lines.length;

        console.log(`\n${'▔'.repeat(20)} 📄 ${title} ${'▔'.repeat(20)}\n`);

        if (totalLines <= 60) {
            await this.printLinesWithDelay(lines, 0, totalLines);
        } else {
            await this.printLinesWithDelay(lines, 0, 50);
            console.log(`\n... [${totalLines - 60} lines omitted] ...\n`);
            await this.printLinesWithDelay(lines, totalLines - 10, 10);
        }

        console.log(`\n${'▁'.repeat(20)} ${title} - END ${'▁'.repeat(20)}\n`);
    }

    // Helper to display menu and handle user interaction
    async showMenu(menuConfig) {
        const { title, options, tokenCounts, onChoice } = menuConfig;

        const showColoredVisualization = () => {
            const { line1, line2 } = this.createColoredVisualization(tokenCounts);
            console.log(line1);
            console.log(line2);
        };

        const displayMenu = () => {
            console.log(title);
            showColoredVisualization();
            console.log(options);
        };

        console.log();
        displayMenu();

        let continueLoop = true;
        while (continueLoop) {
            const choice = await new Promise((resolve) => {
                this.ui.question('Your choice: ', (answer) => {
                    resolve(answer.trim().toUpperCase());
                });
            });

            const result = await onChoice(choice);
            if (result === 'exit') {
                continueLoop = false;
            } else if (result === 'invalid') {
                console.log('Invalid choice. Try again.\n');
            }

            if (continueLoop) {
                displayMenu();
            }
        }
    }

    // Interactive menu to inspect prompt components before sending
    async showInspectionMenu(messages, tools) {
        if (!this.ui || !process.stdin.isTTY) {
            return; // Skip menu if no UI interface (e.g., in tests) or not in TTY
        }

        // Extract different message types
        const systemMessages = messages.filter(m => m.role === 'system');
        const userMessages = messages.filter(m => m.role === 'user');
        const assistantMessages = messages.filter(m => m.role === 'assistant');
        const toolResults = messages.filter(m => m.role === 'tool');

        // Build content strings
        const systemContent = systemMessages.map(m => m.content).join('\n\n');
        const toolsContent = JSON.stringify(tools, null, 2);  // Use compact JSON to match visualizePrompt
        const toolsContentPretty = JSON.stringify(tools, null, 2);  // Pretty version for display
        const userContent = userMessages.map(m => m.content).join('\n\n');
        const assistantContent = assistantMessages.map(m => {
            if (m.content) return m.content;
            if (m.tool_calls) return JSON.stringify(m.tool_calls, null, 2);
            return '';
        }).join('\n\n');
        const resultsContent = toolResults.map(m => m.content).join('\n\n');

        await this.showMenu({
            title: '🔍 INSPECT PROMPT BEFORE SENDING',
            options: '[S]ystem [T]ools [U]ser [A]ssistant [R]esults [C]ont/Enter',
            tokenCounts: [
                { label: 'System', tokens: estimateTokens(systemContent), color: 'green' },
                { label: 'Tools', tokens: estimateTokens(toolsContent), color: 'cyan' },
                { label: 'User', tokens: estimateTokens(userContent), color: 'blue' },
                { label: 'Asst', tokens: estimateTokens(assistantContent), color: 'yellow' },
                { label: 'Res', tokens: estimateTokens(resultsContent), color: 'magenta' }
            ],
            onChoice: async (choice) => {
                switch (choice) {
                    case 'S':
                        await this.dumpContent('SYSTEM PROMPT', systemContent || '(no system prompt)');
                        break;
                    case 'T':
                        await this.dumpContent('TOOLS DEFINITIONS', toolsContentPretty || '(no tools)');
                        break;
                    case 'U':
                        await this.dumpContent('USER MESSAGES', JSON.stringify(userMessages, null, 2) || '(no user messages)');
                        break;
                    case 'A':
                        await this.dumpContent('ASSISTANT MESSAGES', JSON.stringify(assistantMessages, null, 2) || '(no assistant messages)');
                        break;
                    case 'R':
                        await this.dumpContent('TOOL RESULTS', JSON.stringify(toolResults, null, 2) || '(no tool results)');
                        break;
                    case 'C':
                    case '':
                        console.log('Continuing with request...\n');
                        return 'exit';
                    default:
                        return 'invalid';
                }
            }
        });
    }

    // Interactive menu to inspect LLM response after receiving
    async showResponseInspectionMenu(llmResponse) {
        if (!this.ui || !process.stdin.isTTY) {
            return; // Skip menu if no UI interface (e.g., in tests) or not in TTY
        }

        const responseContent = llmResponse.content;
        const toolCallsContent = llmResponse.toolCalls
            ? JSON.stringify(llmResponse.toolCalls, null, 2)
            : '';
        const fullResponse = JSON.stringify(llmResponse, null, 2);

        await this.showMenu({
            title: '🔍 INSPECT LLM RESPONSE',
            options: '[R]esponse [T]ool-calls [F]ull-JSON [C]ont/Enter',
            tokenCounts: [
                { label: 'Response', tokens: estimateTokens(responseContent), color: 'yellow' },
                { label: 'Tool-Calls', tokens: estimateTokens(toolCallsContent), color: 'cyan' }
            ],
            onChoice: async (choice) => {
                switch (choice) {
                    case 'R':
                        await this.dumpContent('RESPONSE CONTENT', responseContent || '(no response content)');
                        break;
                    case 'T':
                        await this.dumpContent('TOOL CALLS REQUESTED', toolCallsContent || '(no tool calls)');
                        break;
                    case 'F':
                        await this.dumpContent('FULL RESPONSE (RAW JSON)', fullResponse);
                        break;
                    case 'C':
                    case '':
                        console.log('Continuing...\n');
                        return 'exit';
                    default:
                        return 'invalid';
                }
            }
        });
    }

    // Helper to manage activity indicator lifecycle during API call
    async withActivityIndicator(apiCall) {
        if (this.ui && this.ui.startActivity) {
            this.ui.startActivity('📤 Sending');
        }

        try {
            const response = await apiCall();

            // Change to receiving indicator
            if (this.ui && this.ui.stopActivity) {
                this.ui.stopActivity();
            }
            if (this.ui && this.ui.startActivity) {
                this.ui.startActivity('📥 Receiving');
            }

            return response;
        } catch (error) {
            if (this.ui && this.ui.stopActivity) {
                this.ui.stopActivity();
            }
            throw error;
        }
    }

    // Helper to finalize response after receiving
    async finalizeResponse(data, parser) {
        // Wait for receiving animation to complete
        if (this.ui && this.ui.waitForAnimationCycle) {
            await this.ui.waitForAnimationCycle('right-to-left', '📥');
        }

        // Stop activity indicator
        if (this.ui && this.ui.stopActivity) {
            this.ui.stopActivity();
        }

        return parser(data);
    }

    // Call the LLM API with tool support
    async chat(messages, tools = []) {
        if (!this.config.isValid()) {
            throw new Error('LLM configuration is incomplete. Please configure your API settings.');
        }

        const provider = this.config.provider;

        if (provider === 'openai' || provider === 'azure' || provider === 'custom') {
            return await this.callOpenAI(messages, tools);
        } else if (provider === 'anthropic') {
            return await this.callAnthropic(messages, tools);
        } else if (provider === 'ollama') {
            return await this.callOllama(messages, tools);
        }
    }

    // OpenAI API format (also works for Azure and custom)
    async callOpenAI(messages, tools = []) {
        const payload = {
            model: this.config.model,
            messages: messages
        };

        // Add tools if provided
        if (tools && tools.length > 0) {
            payload.tools = tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                }
            }));
            payload.tool_choice = 'auto';
        }

        // Determine auth header based on endpoint (Azure vs OpenAI)
        const isAzure = this.config.endpoint.includes('azure.com');
        const headers = {
            'Content-Type': 'application/json'
        };

        if (isAzure) {
            headers['api-key'] = this.config.apiKey;
        } else {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const response = await this.withActivityIndicator(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
            try {
                return await fetch(this.config.endpoint, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeout);
            }
        });

        if (!response.ok) {
            if (this.ui && this.ui.stopActivity) {
                this.ui.stopActivity();
            }
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return await this.finalizeResponse(data, this.parseOpenAIResponse.bind(this));
    }

    // Anthropic API format
    async callAnthropic(messages, tools = []) {
        const systemMessage = messages.find(m => m.role === 'system');
        
        // Transform messages for Anthropic API format
        // Anthropic doesn't support role: 'tool' directly
        // Tool results must be in tool_result content blocks within user messages
        const anthropicMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                continue; // Skip system messages (handled separately)
            } else if (msg.role === 'tool') {
                // Convert tool result to Anthropic format
                anthropicMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: msg.content
                    }]
                });
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                // Assistant message with tool calls - convert to Anthropic format
                const content = [];
                if (msg.content) {
                    content.push({
                        type: 'text',
                        text: msg.content
                    });
                }
                // Add tool_use blocks
                for (const tc of msg.tool_calls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input: JSON.parse(tc.function.arguments)
                    });
                }
                anthropicMessages.push({
                    role: 'assistant',
                    content: content
                });
            } else {
                // Regular user or assistant message
                anthropicMessages.push(msg);
            }
        }

        const payload = {
            model: this.config.model,
            max_tokens: 4096,
            messages: anthropicMessages
        };

        if (systemMessage) {
            payload.system = systemMessage.content;
        }

        if (tools && tools.length > 0) {
            payload.tools = tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters
            }));
        }

        const response = await this.withActivityIndicator(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
            try {
                return await fetch(this.config.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.config.apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeout);
            }
        });

        if (!response.ok) {
            if (this.ui && this.ui.stopActivity) {
                this.ui.stopActivity();
            }
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return await this.finalizeResponse(data, this.parseAnthropicResponse.bind(this));
    }

    // Ollama API format (local)
    async callOllama(messages, tools = []) {
        const payload = {
            model: this.config.model,
            messages: messages,
            stream: false
        };

        const response = await this.withActivityIndicator(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
            
            try {
                return await fetch(this.config.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeout);
            }
        });

        if (!response.ok) {
            if (this.ui && this.ui.stopActivity) {
                this.ui.stopActivity();
            }
            const error = await response.text();
            throw new Error(`Ollama API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return await this.finalizeResponse(data, (d) => ({
            content: d.message.content,
            toolCalls: []
        }));
    }

    // Parse OpenAI response
    parseOpenAIResponse(data) {
        const message = data.choices[0].message;
        const result = {
            content: message.content || '',
            toolCalls: []
        };

        if (message.tool_calls) {
            result.toolCalls = message.tool_calls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments)
            }));
        }

        return result;
    }

    // Parse Anthropic response
    parseAnthropicResponse(data) {
        const result = {
            content: '',
            toolCalls: []
        };

        for (const block of data.content) {
            if (block.type === 'text') {
                result.content += block.text;
            } else if (block.type === 'tool_use') {
                result.toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: block.input
                });
            }
        }

        return result;
    }
}

module.exports = { LLMConfig, LLMClient };
