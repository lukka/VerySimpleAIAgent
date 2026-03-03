// VerySimpleAIAgent - Coordinates tools and processes user questions

const { estimateTokens } = require('./utils');

// System prompt template - used for generating the full system prompt with available tools
const SYSTEM_PROMPT_TEMPLATE = (tools, configFile) => `You are a helpful AI assistant with access to tools. You can help users with various tasks.

Configuration file in use: ${configFile || 'not configured'}

Available tools:
${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

You can use tools multiple times in sequence to complete complex tasks:
- Call a tool to gather information
- Use the result to decide what to do next
- Call more tools as needed
- Provide a final answer when the task is complete

Tool Selection Guidelines:
- Use JavaScriptTool for: JavaScript calculations, Math operations, data processing, safe code execution
- Use ShellCommand for: File system operations (ls, cat, grep), system info (df, ps, uname), running programs
- Use Think for: Complex reasoning and analysis before taking action
- ShellCommand requires user confirmation, so only use it when necessary
- Prefer JavaScriptTool when both could work, as it doesn't require confirmation

Be helpful, concise, and use tools when appropriate. Break down complex tasks into steps.`;

class Agent {
    static TOKENS_PER_BLOCK = 50;

    constructor(tools = [], llmClient = null, ui = null) {
        this.tools = tools;
        this.llmClient = llmClient;
        this.ui = ui;
        this.conversationHistory = [];
        this.supportsColors = this.detectColorSupport();
        this.lastVisualizationLineCount = 0; // Track lines for in-place update

        // System prompt
        this.systemPrompt = SYSTEM_PROMPT_TEMPLATE(tools, llmClient?.config?.configFile);
    }

    // Get color codes based on terminal support
    getColorCodes() {
        return this.supportsColors ? {
            reset: '\x1b[0m',
            green: '\x1b[42m',
            blue: '\x1b[44m',
            yellow: '\x1b[43m',
            cyan: '\x1b[46m',
            magenta: '\x1b[45m',
        } : {
            reset: '', green: '', blue: '', yellow: '', cyan: '', magenta: '',
        };
    }

    // Calculate tokens by role from conversation history
    calculateTokensByRole() {
        let userTokens = 0;
        let assistantTokens = 0;
        let toolResultTokens = 0;

        for (const msg of this.conversationHistory) {
            const content = msg.content || '';
            const tokens = estimateTokens(content);

            if (msg.role === 'user') {
                userTokens += tokens;
            } else if (msg.role === 'assistant') {
                assistantTokens += tokens;
            } else if (msg.role === 'tool') {
                toolResultTokens += tokens;
            }
        }

        return { userTokens, assistantTokens, toolResultTokens };
    }

    // Create colored blocks for token visualization
    createColoredBlocks(tokenCounts, colors) {
        const blocks = [];

        for (const { tokens, color } of tokenCounts) {
            const blockCount = Math.ceil(tokens / Agent.TOKENS_PER_BLOCK);
            for (let i = 0; i < blockCount; i++) {
                blocks.push(`${colors[color]}   ${colors.reset}`);
            }
        }

        return blocks;
    }

    // Build visualization lines (line1: blocks, line2: labels)
    buildVisualizationLines(systemTokens, toolTokens, userTokens, assistantTokens, toolResultTokens) {
        const colors = this.getColorCodes();
        const totalTokens = systemTokens + toolTokens + userTokens + assistantTokens + toolResultTokens;

        const tokenCounts = [
            { tokens: systemTokens, color: 'green' },
            { tokens: toolTokens, color: 'cyan' },
            { tokens: userTokens, color: 'blue' },
            { tokens: assistantTokens, color: 'yellow' },
            { tokens: toolResultTokens, color: 'magenta' }
        ];

        const blocks = this.createColoredBlocks(tokenCounts, colors);
        const blocksViz = blocks.join('');
        const line1 = `📊 ${blocksViz} ${totalTokens} tokens`;

        let line2 = '';
        if (this.supportsColors) {
            line2 = `   ${colors.green}■${colors.reset}System:${systemTokens} ${colors.cyan}■${colors.reset}Tools:${toolTokens} ${colors.blue}■${colors.reset}User:${userTokens} ${colors.yellow}■${colors.reset}Asst:${assistantTokens} ${colors.magenta}■${colors.reset}Res:${toolResultTokens}`;
        } else {
            line2 = `   S:${systemTokens} T:${toolTokens} U:${userTokens} A:${assistantTokens} R:${toolResultTokens}`;
        }

        return { line1, line2, totalTokens };
    }

    // Breakpoint: Show source code context at key execution phases
    // Now supports explicit file/phase parameters (line is found dynamically)
    async breakpoint(label = 'Breakpoint', options = {}) {
        if (this.ui && typeof this.ui.updateDebugContextWithLocation === 'function') {
            // File and phase must be provided (line is found automatically)
            if (options.file && options.phase) {
                await this.ui.updateDebugContextWithLocation(
                    options.file,
                    options.line,  // Optional: if not provided, will be found dynamically
                    options.phase
                ).catch((err) => { 
                    // Log error to file for debugging since console won't show in alternate screen
                    require('fs').appendFileSync('breakpoint-error.log', `Error in updateDebugContextWithLocation: ${err.message}\n${err.stack}\n\n`);
                });
            }
            // Note: No fallback - all breakpoints must specify file/phase

            // Add a visual indicator in the top panel
            if (this.ui.addToTopPanel) {
                const phaseLabel = options.phase ? `🎯 STATE: ${options.phase}` : label;
                this.ui.addToTopPanel(`\n${phaseLabel}`);
            }

            // Wait for user to press Enter to continue (unless skipWait is true)
            if (this.ui.question && !options.skipWait) {
                await new Promise(resolve => {
                    this.ui.question('Press Enter to continue...', () => resolve());
                });
            }
        }
    }

    // Register a tool with the agent
    registerTool(tool) {
        this.tools.push(tool);
        this.updateSystemPrompt();
    }

    // Update system prompt when tools change
    updateSystemPrompt() {
        this.systemPrompt = SYSTEM_PROMPT_TEMPLATE(this.tools, this.llmClient?.config?.configFile);
    }

    // Get tool by name
    getTool(name) {
        return this.tools.find(tool => tool.name === name);
    }

    // Main agent algorithm:
    // ┌──▶ wait for a user's question
    // │   chat_history.push(question)
    // │   ┌──▶ response = llm.chat(prompt)
    // │   │   if tool calls in response exist
    // │   │     result = tool.invoke()
    // │   └────prompt += tool's invocation + result
    // │   chat_history.push(response)
    // └───display response
    async processQuestion(question) {
        console.log('🤖 Processing question:', question);

        await this.breakpoint('Adding question to chat history', {
            file: __filename,
            phase: 'chat_history.push(question)'
        });

        // Phase: chat_history.push(question)
        this.conversationHistory.push({ role: 'user', content: question });

        // Use LLM to determine response and tool usage
        const response = await this.agentInnerLoop(question);

        await this.breakpoint('Adding response to chat history', {
            file: __filename,
            phase: 'chat_history.push(response)'
        });

        // Phase: chat_history.push(response)
        this.conversationHistory.push({ role: 'assistant', content: response });

        return response;
    }

    // Agent's inner loop - uses LLM to decide which tools to use
    async agentInnerLoop(question) {
        // If no LLM client, display error
        if (!this.llmClient) {
            return '⚠️  Error: No LLM client configured.\n\nPlease configure your LLM API settings by typing "config" to set up the connection.';
        }

        try {
            // Prepare promptMessages for LLM
            const promptMessages = [
                { role: 'system', content: this.systemPrompt },
                ...this.conversationHistory
            ];

            // Prepare tools in the format expected by LLM
            const toolSchemas = this.tools.map(tool => tool.getMetadata());

            // Agentic loop: allow multiple LLM calls until task is complete
            const maxIterations = 42; // Safety limit to prevent infinite loops
            let iteration = 0;
            let finalAnswer = null;

            // Loop continues until one of two conditions:
            // 1. LLM returns a response without tool calls (task complete) - see break below
            // 2. Maximum iterations reached (safety limit) - loop condition fails
            // Each iteration: LLM responds → if tool calls exist, execute them and continue loop
            while (iteration < maxIterations) {
                iteration++;

                await this.breakpoint(`Querying LLM (iteration ${iteration})`, {
                    file: __filename,
                    phase: 'response = llm.chat(prompt)'
                });

                // Show prompt visualization BEFORE sending to LLM
                await this.showPromptVisualization(iteration, promptMessages, toolSchemas);

                // Call LLM with proper cleanup handling
                let llmResponse;
                try {
                    llmResponse = await this.withAnimation(() =>
                        // Phase: response = llm.chat(prompt)
                        this.llmClient.chat(promptMessages, toolSchemas)
                    );
                } catch (llmError) {
                    const configFile = this.llmClient?.config?.configFile || 'unknown';
                    console.error(`🤖 LLM call failed (iteration ${iteration}):`, llmError.message);
                    return [
                        `⚠️  LLM API call failed: ${llmError.message}`,
                        ``,
                        `Config file: ${configFile}`,
                        ``,
                        `Possible fixes:`,
                        `  • Type "config" to review or update your API settings`,
                        `  • Verify your API key is valid and has sufficient quota`,
                        `  • Check that the endpoint URL is correct`,
                        `  • Ensure the model name is spelled correctly`,
                    ].join('\n');
                }

                // Visualize response AFTER receiving it
                await this.showResponseVisualization(iteration, llmResponse);

                await this.breakpoint('Checking if tool calls exist in response', {
                    file: __filename,
                    phase: 'if tool calls in response exist'
                });

                // Phase: if tool calls in response exist
                if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
                    // Phase: result = tool.invoke()
                    const toolResults = await this.executeToolCalls(llmResponse);

                    await this.breakpoint('Updating prompt with tool result', {
                        file: __filename,
                        phase: 'prompt += tool\'s invocation + result'
                    });

                    // Phase: prompt += tool's invocation + result
                    this.addAssistantAndToolResultsToMessages(promptMessages, llmResponse, toolResults);

                    // Continue loop - LLM will see tool results and decide next action
                    continue;
                }

                // No tool calls - LLM has finished the task
                finalAnswer = llmResponse.content;
                break;
            }

            if (iteration >= maxIterations) {
                console.log('🤖 ⚠️  Maximum iterations reached. Returning current response.');
                return finalAnswer || 'Task incomplete: maximum iteration limit reached.';
            }

            if (iteration > 1) {
                console.log(`🤖 ✅ Task completed in ${iteration} iteration(s)\n`);
            }

            return finalAnswer;

        } catch (error) {
            console.error('🤖 Agent error:', error.message);
            const configFile = this.llmClient?.config?.configFile || 'unknown';
            return [
                `⚠️  Agent error: ${error.message}`,
                ``,
                `Config file: ${configFile}`,
                ``,
                `Type "config" to review your API settings.`,
            ].join('\n');
        }
    }

    // Show prompt visualization or inspection menu before sending to LLM
    async showPromptVisualization(iteration, promptMessages, toolSchemas) {
        if (iteration > 1) {
            console.log(`\n🤖 🔄 Iteration ${iteration}: Continuing task...`);
        }

        // Always show inspection menu before sending to LLM
        if (this.llmClient && this.llmClient.showInspectionMenu) {
            await this.llmClient.showInspectionMenu(promptMessages, toolSchemas);
        }
    }

    // Generic wrapper to run async operations (animation handled by terminal UI)
    async withAnimation(asyncOperation) {
        return await asyncOperation();
    }

    // Show response visualization, inspection menu, and conversation history
    async showResponseVisualization(iteration, llmResponse) {
        // Always show response inspection menu after receiving
        if (this.llmClient && this.llmClient.showResponseInspectionMenu) {
            await this.llmClient.showResponseInspectionMenu(llmResponse);
        }
    }

    // Helper to create tool result object
    createToolResult(id, result) {
        return { id, result: String(result) };
    }

    // Execute tool calls requested by LLM
    async executeToolCalls(llmResponse) {
        const results = [];
        const toolCalls = llmResponse.toolCalls || [];

        console.log(`🤖 LLM requested ${toolCalls.length} tool call(s)`);

        await this.breakpoint(`Executing ${toolCalls.length} tool call(s)`, {
            file: __filename,
            phase: 'result = tool.invoke()'
        });

        for (const toolCall of toolCalls) {
            const tool = this.getTool(toolCall.name);

            if (!tool) {
                results.push(this.createToolResult(toolCall.id, `Error: Tool ${toolCall.name} not found`));
                continue;
            }

            try {
                // Phase: result = tool.invoke()
                const result = await tool.execute(toolCall.arguments);
                results.push(this.createToolResult(toolCall.id, result));
            } catch (error) {
                results.push(this.createToolResult(toolCall.id, `Error executing ${toolCall.name}: ${error.message}`));
            }
        }

        return results;
    }

    // Add assistant message with tool calls to conversation history
    addAssistantMessageWithToolCalls(promptMessages, llmResponse) {
        const message = {
            role: 'assistant',
            content: llmResponse.content || ''
        };

        // Only add tool_calls if there are actual tool calls
        if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
            message.tool_calls = llmResponse.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments)
                }
            }));
        }

        promptMessages.push(message);
    }

    // Add assistant and tool results to promptMessages array
    addAssistantAndToolResultsToMessages(promptMessages, llmResponse, toolResults) {
        // Add assistant message with tool calls to promptMessages
        this.addAssistantMessageWithToolCalls(promptMessages, llmResponse);

        // Add tool results to conversation
        for (const result of toolResults) {
            promptMessages.push({
                role: 'tool',
                tool_call_id: result.id,
                content: result.result
            });
        }
    }

    // Simple fallback when LLM is not available
    simpleFallback(question) {
        const lowerQuestion = question.toLowerCase();

        // Check if the question requires command execution
        const needsCommand =
            lowerQuestion.includes('run') ||
            lowerQuestion.includes('execute') ||
            lowerQuestion.includes('script') ||
            lowerQuestion.includes('eval') ||
            lowerQuestion.includes('calculate') ||
            lowerQuestion.includes('compute');

        if (needsCommand) {
            const script = this.extractScript(question);

            if (script) {
                try {
                    const jsTool = this.getTool('JavaScriptTool');
                    if (jsTool) {
                        return `I would execute: ${script}\n\nNote: Configure LLM settings for intelligent responses (type "config").`;
                    }
                } catch (error) {
                    return `Error: ${error.message}`;
                }
            }
        }

        return this.generateSimpleResponse(question);
    }

    // Extract script/code from user question
    extractScript(question) {
        // Check for code in backticks
        const codeMatch = question.match(/`([^`]+)`/);
        if (codeMatch) return codeMatch[1];

        // Check for various command patterns
        const patterns = [
            /(?:calculate|compute|eval)\s+(.+)/i,
            /(?:run|execute)\s+(.+)/i
        ];

        for (const pattern of patterns) {
            const match = question.match(pattern);
            if (match) return match[1];
        }

        return null;
    }

    // Generate a response without using tools (fallback)
    generateSimpleResponse(question) {
        const responses = {
            greeting: "Hello! I'm an AI agent with the ability to run JavaScript using JavaScriptTool. Configure LLM for intelligent responses (type 'config').",
            help: "I can help you execute JavaScript code. Type 'config' to set up LLM integration!",
            default: `I received your question: "${question}". Type "config" to enable LLM-powered responses.`
        };

        const lowerQuestion = question.toLowerCase();

        if (lowerQuestion.match(/\b(hello|hi|hey)\b/)) {
            return responses.greeting;
        }

        if (lowerQuestion.match(/\b(help|what can you do)\b/)) {
            return responses.help;
        }

        return responses.default;
    }

    // Get conversation history
    getHistory() {
        return this.conversationHistory;
    }

    // Detect if terminal supports ANSI colors
    detectColorSupport() {
        // Check various environment variables and conditions
        if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) {
            return false;
        }

        if (process.env.FORCE_COLOR) {
            return true;
        }

        // Check if we're in a TTY and common terminal types
        if (process.stdout.isTTY) {
            const term = process.env.TERM;
            const colorTerm = process.env.COLORTERM;

            // Windows Terminal, VS Code integrated terminal, etc.
            if (colorTerm === 'truecolor' ||
                process.env.TERM_PROGRAM === 'vscode' ||
                process.env.WT_SESSION ||
                term && (term.includes('color') || term.includes('256') || term.includes('xterm'))) {
                return true;
            }

            // Default TTY support
            return true;
        }

        return false;
    }

    // Visualize the prompt being sent to LLM
    async visualizePrompt(promptMessages, toolSchemas) {
        // Calculate tokens from persistent data sources
        const systemTokens = estimateTokens(this.systemPrompt || '');
        const toolTokens = estimateTokens(JSON.stringify(toolSchemas));

        // Calculate tokens from conversation history
        const { userTokens, assistantTokens, toolResultTokens } = this.calculateTokensByRole();

        // Build visualization lines
        const { line1, line2 } = this.buildVisualizationLines(
            systemTokens, toolTokens, userTokens, assistantTokens, toolResultTokens
        );

        // Update visualization in place (replace last visualization if it exists)
        const newVisualizationLines = ['', line1, line2]; // Include blank line for spacing
        if (this.ui && this.ui.replaceLastTopPanelLines && this.lastVisualizationLineCount > 0) {
            this.ui.replaceLastTopPanelLines(this.lastVisualizationLineCount, newVisualizationLines);
        } else if (this.ui && this.ui.addToTopPanel) {
            // First time - add normally
            newVisualizationLines.forEach(line => this.ui.addToTopPanel(line));
        }
        this.lastVisualizationLineCount = newVisualizationLines.length;

        // Use both lines for middle panel (identical to top panel)
        const visualizationLines = [line1, line2];

        // Update middle panel with visualization (keep at top)
        if (this.ui && this.ui.updatePromptVisualization) {
            this.ui.updatePromptVisualization(visualizationLines);
        } else {
            // Fallback to console.log if UI not available
            visualizationLines.forEach(line => console.log(line));
            console.log('');
        }
    }
}

module.exports = { Agent };
