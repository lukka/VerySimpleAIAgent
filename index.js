#!/usr/bin/env node

/**
 * AI Agent Console Application
 * Run with: node index.js
 */

// Prevent multiple execution
if (global.__myagent_running) {
    console.error('Warning: Application already running!');
    process.exit(1);
}
global.__myagent_running = true;

const { TerminalUI, BG_COLORS } = require('./terminal-ui');
const { Agent } = require('./agent-node');
const { JavaScriptTool, ShellCommandTool, ThinkTool } = require('./tools-node');
const { LLMClient, LLMConfig } = require('./llm-node');

// Create terminal UI
const ui = new TerminalUI();

// Redirect console.log to UI with special handling for tool output
// Track if we're inside a tool execution block
let inToolExecution = false;
let toolExecutionColor = 'CYAN';
let inInspectSection = false;

console.log = (...args) => {
    const text = args.join(' ');

    // Detect inspect section start
    if (text.includes('INSPECT PROMPT') || text.includes('INSPECT RESPONSE')) {
        inInspectSection = true;
        ui.setBgColor('BLACK');
    }

    // Detect tool execution start
    if (text.includes('EXECUTION START:')) {
        inToolExecution = true;
        inInspectSection = false; // Exit inspect if we were in it
    }

    // If in inspect section, add to top panel (Agent Inner Workings)
    if (inInspectSection) {
        ui.addToTopPanel(text);
    } else {
        ui.log(text);
    }

    // Detect tool execution end
    if (text.includes('TOOL EXECUTION END:')) {
        inToolExecution = false;
        ui.resetBgColor();
    }

    // Detect inspect section end (when "Continuing" message appears)
    if (inInspectSection && (text.includes('Continuing with request') || text.includes('Continuing...'))) {
        inInspectSection = false;
        ui.resetBgColor();
    }
};

console.error = (...args) => {
    ui.setBgColor('RED');
    ui.log('❌ ' + args.join(' '));
    ui.resetBgColor();
};

// Initialize the agent
let agent;
let config;

// Display welcome message
ui.log('VerySimpleAgent with Tools: JavaScriptTool + ShellCommandTool + ThinkTool');
ui.log('Commands: bye, config, history, help');
ui.log('');

// Initialize the agent with configuration
function initializeAgent() {
    try {
        config = new LLMConfig();

        if (!config.isValid()) {
            ui.log('⚠️  LLM not configured. Agent in simple mode.');
            ui.log('Type "config" to set up your LLM API.');
        }

        const llmClient = new LLMClient(config, ui); // Pass the UI interface
        const jsTool = new JavaScriptTool(ui); // Pass the UI interface
        const shellTool = new ShellCommandTool(ui); // Pass the UI interface
        const thinkTool = new ThinkTool();
        agent = new Agent([jsTool, shellTool, thinkTool], llmClient, ui);

        // Initialize visualization with actual system and tool tokens
        ui.initializeVisualizationFromAgent(agent);

        ui.log('VerySimpleAgent initialized successfully!');

        if (config.isValid()) {
            ui.log(`Provider: ${config.provider} | Model: ${config.model}`);
        } else {
            ui.log('💡 Tip: Use "config" command to configure LLM');
        }
    } catch (error) {
        ui.log(`❌ Error initializing agent: ${error.message}`);
        process.exit(1);
    }
}

// Handle configuration
async function configureAgent() {
    const { LLMConfig } = require('./llm-node');
    const presets = LLMConfig.getPresets();

    ui.log('╔════════════════════════════════════════════════════════════╗');
    ui.log('║  Configuration Menu                                        ║');
    ui.log('╚════════════════════════════════════════════════════════════╝');
    ui.log('Available providers:');
    ui.log('  1. OpenAI  2. Azure  3. Anthropic  4. Ollama  5. Custom');

    return new Promise((resolve) => {
        ui.question('Select provider (1-5): ', (choice) => {
            const providers = ['openai', 'azure', 'anthropic', 'ollama', 'custom'];
            const provider = providers[parseInt(choice) - 1] || 'openai';
            const preset = presets[provider];

            ui.question(`API Key${provider === 'ollama' ? ' (Enter to skip)' : ''}: `, (apiKey) => {
                const actualApiKey = provider === 'ollama' ? 'not-required' : apiKey;

                ui.question(`Endpoint (default: ${preset.endpoint}): `, (endpoint) => {
                    const actualEndpoint = endpoint || preset.endpoint;

                    ui.question(`Model (default: ${preset.defaultModel}): `, (model) => {
                        const actualModel = model || preset.defaultModel;

                        config.update({
                            provider,
                            apiKey: actualApiKey,
                            endpoint: actualEndpoint,
                            model: actualModel
                        });

                        ui.log('✅ Configuration saved!');
                        initializeAgent();
                        resolve();
                    });
                });
            });
        });
    });
}

// Process user input
async function processInput(input) {
    const trimmedInput = input.trim();

    if (!trimmedInput) {
        return;
    }

    // Handle special commands
    if (trimmedInput === 'bye') {
        ui.log('👋 Goodbye!');
        ui.close();
        process.exit(0);
    }

    if (trimmedInput === 'config') {
        // Show user input in green background
        ui.setBgColor('GREEN');
        ui.log(`🐱 You: ${trimmedInput}`);
        ui.resetBgColor();
        await configureAgent();
        // Show breakpoint before waiting for next input
        await agent.breakpoint('Waiting for question from user', {
            file: __filename,
            phase: 'wait for a user\'s question',
            skipWait: true
        });
        return;
    }

    if (trimmedInput === 'help') {
        // Show user input in green background
        ui.setBgColor('GREEN');
        ui.log(`🐱 You: ${trimmedInput}`);
        ui.resetBgColor();
        ui.log('Available commands:');
        ui.log('  config  - Configure LLM settings');
        ui.log('  history - Show conversation history');
        ui.log('  help    - Show this help');
        ui.log('  bye     - Exit application');
        // Show breakpoint before waiting for next input
        await agent.breakpoint('Waiting for question from user', {
            file: __filename,
            phase: 'wait for a user\'s question',
            skipWait: true
        });
        return;
    }

    if (trimmedInput === 'history') {
        // Show user input in green background
        ui.setBgColor('GREEN');
        ui.log(`🐱 You: ${trimmedInput}`);
        ui.resetBgColor();
        agent.printHistorySummary();
        // Show breakpoint before waiting for next input
        await agent.breakpoint('Waiting for question from user', {
            file: __filename,
            phase: 'wait for a user\'s question',
            skipWait: true
        });
        return;
    }

    // Process with agent - show user input and start thinking animation
    try {
        ui.setBgColor('GREEN');
        ui.log(`🐱 You: ${trimmedInput}`);
        ui.resetBgColor();
        
        // Start thinking animation (just the rotating character, no label)
        ui.startThinking();

        const response = await agent.processQuestion(trimmedInput);
        
        // Stop thinking animation
        ui.stopThinking();

        await agent.breakpoint('Return final answer to user', {
            file: __filename,
            phase: 'display response'
        });

        // Set green background for agent response
        ui.setBgColor('GREEN');
        // Phase: display response
        ui.log(`🤖 Agent: ${response}`);
        ui.resetBgColor();

    } catch (error) {
        // Stop thinking animation on error
        ui.stopThinking();
        
        ui.setBgColor('RED');
        ui.log(`❌ Error: ${error.message}`);
        ui.resetBgColor();
    }

    // Show breakpoint before waiting for next input
    await agent.breakpoint('Waiting for question from user', {
        file: __filename,
        phase: 'wait for a user\'s question',
        skipWait: true
    });
}

// Initialize agent on startup
initializeAgent();

// Show initial state - waiting for user question (right before event loop becomes active)
agent.breakpoint('Waiting for question from user', {
    file: __filename,
    phase: 'wait for a user\'s question',
    skipWait: true  // Don't wait for Enter since we're already waiting for user input
});

// Track if we're currently processing input to prevent re-entry
let isProcessingInput = false;

// Handle user input (register only once)
if (!global.__myagent_handler_registered) {
    global.__myagent_handler_registered = true;

    // Phase: wait for a user's question
    ui.on('line', async (input) => {
        // Only process if there's actual input
        // (empty input still needs to propagate to other handlers like question())
        if (input && input.trim()) {
            // Prevent re-entrant calls
            if (isProcessingInput) {
                return;
            }
            isProcessingInput = true;
            try {
                await processInput(input);
            } finally {
                isProcessingInput = false;
            }
        }
    });
}
