// Tools for Node.js Agent - JavaScriptTool, ShellCommandTool, and ThinkTool

const vm = require('vm');
const { execSync } = require('child_process');
const { padToVisualWidth } = require('./utils');

class JavaScriptTool {
    constructor(mainReadlineInterface = null) {
        this.name = 'JavaScriptTool';
        this.description = 'Executes JavaScript expressions in a sandboxed environment with 5-second timeout. RESTRICTIONS: (1) Use expressions only - NO variable declarations (const/let/var), (2) NO file system or network access, (3) NO async/await, (4) Available APIs: Math, Date, JSON, Array, Object, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite. Examples: "2 + 2", "Math.sqrt(16)", "[1,2,3].map(x => x * 2)", "JSON.stringify({a:1})", "new Date().toISOString()".';
        this.mainRl = mainReadlineInterface; // Reference to the main readline interface
    }

    // Show pause menu after tool execution
    async showPauseMenu() {
        return new Promise((resolve) => {
            // Use the main readline interface if available
            if (this.mainRl) {
                this.mainRl.question('Press Enter to continue...', () => {
                    console.log('Continuing...\n');
                    resolve();
                });
            } else {
                console.warn('No readline interface available for JavaScriptTool pause menu');
                resolve();
            }
        });
    }

    // Execute a script
    async execute({ script }) {
        if (!script) {
            throw new Error('No script provided to execute');
        }

        console.log('▶️  Tool execution start: JavaScriptTool');
        console.log('─'.repeat(76));
        console.log(script);

        try {
            // Create a sandboxed execution context
            const sandbox = {
                // Provide safe APIs
                console: {
                    log: (...args) => {
                        console.log('[Script Output]:', ...args);
                        return args.join(' ');
                    }
                },
                Math: Math,
                Date: Date,
                JSON: JSON,
                Array: Array,
                Object: Object,
                String: String,
                Number: Number,
                Boolean: Boolean,
                parseInt: parseInt,
                parseFloat: parseFloat,
                isNaN: isNaN,
                isFinite: isFinite
            };

            // Wrap script to capture result
            const wrappedScript = `
                (function() {
                    'use strict';
                    try {
                        const result = ${script};
                        return result;
                    } catch (e) {
                        throw new Error('Script execution error: ' + e.message);
                    }
                })();
            `;

            // Create VM context
            const context = vm.createContext(sandbox);

            // Execute the script with timeout
            const result = vm.runInContext(wrappedScript, context, {
                timeout: 5000, // 5 second timeout
                displayErrors: true
            });

            // Format and return the result
            const formattedResult = this.formatResult(result);

            console.log('─'.repeat(76));
            console.log('Result:', formattedResult);
            console.log('─'.repeat(76));
            console.log('⏹️  Tool execution end: JavaScriptTool\n');

            // Show pause menu
            await this.showPauseMenu();

            return formattedResult;

        } catch (error) {
            console.log('─'.repeat(76));
            console.error('❌ Error:', error.message);
            console.log('─'.repeat(76));
            console.log('⏹️  Tool execution end: JavaScriptTool (error)\n');

            // Show pause menu even on error
            await this.showPauseMenu();

            throw new Error(`Failed to execute script: ${error.message}`);
        }
    }

    // Format the result for display
    formatResult(result) {
        if (result === undefined) {
            return 'undefined';
        }
        if (result === null) {
            return 'null';
        }
        if (typeof result === 'function') {
            return '[Function]';
        }
        if (typeof result === 'object') {
            try {
                return JSON.stringify(result, null, 2);
            } catch (e) {
                return String(result);
            }
        }
        return String(result);
    }

    // Get tool metadata for LLM function calling
    getMetadata() {
        return {
            name: this.name,
            description: this.description,
            parameters: {
                type: 'object',
                properties: {
                    script: {
                        type: 'string',
                        description: 'JavaScript expression to evaluate (5-sec timeout). MUST be a single expression that returns a value. RESTRICTIONS: NO variable declarations (const/let/var), NO async/await, NO require/import, NO file/network access. Available: Math, Date, JSON, Array methods, String methods. Examples: "Math.pow(5, 2)", "[1,2,3].reduce((a,b) => a+b, 0)", "new Date().getTime()", "{a: 1, b: 2}.a + {a: 1, b: 2}.b".'
                    }
                },
                required: ['script']
            }
        };
    }
}

// ShellCommand Tool - Executes actual shell commands with user confirmation
class ShellCommandTool {
    constructor(ui = null) {
        this.name = 'ShellCommand';
        this.description = 'Executes shell commands on the local host with mandatory user confirmation. SAFETY GUIDELINES: (1) Prefer read-only commands (ls, cat, grep, find) over write operations, (2) NEVER use destructive commands without clear user intent (rm, dd, mkfs, format), (3) Avoid commands that modify system config (chmod, chown on system files), (4) Use specific paths instead of wildcards when possible, (5) Limit commands to 30-second timeout. User will review and approve each command before execution. Use for: file system inspection, reading files, system information, running scripts/programs.';
        this.ui = ui; // Reference to the UI interface (for readline)
    }

    // Show pause menu after tool execution
    async showPauseMenu() {
        return new Promise((resolve) => {
            // Use the UI interface if available
            if (this.ui) {
                this.ui.question('Press Enter to continue...', () => {
                    console.log('Continuing...\n');
                    resolve();
                });
            } else {
                console.warn('No UI interface available for ShellCommand pause menu');
                resolve();
            }
        });
    }

    // Ask user for confirmation
    async askConfirmation(command) {
        if (!this.ui) {
            throw new Error('No UI interface available for command confirmation');
        }

        return new Promise((resolve) => {
            console.log('\n╔════════════════════════════════════════════════════════════╗');
            console.log('║  ⚠️  SHELL COMMAND EXECUTION REQUEST                      ║');
            console.log('╚════════════════════════════════════════════════════════════╝');
            console.log('\nThe agent wants to run this command:');
            console.log('┌────────────────────────────────────────────────────────────┐');
            console.log(`│ ${padToVisualWidth(command.substring(0, 58), 58)} │`);
            if (command.length > 58) {
                // Handle long commands
                let remaining = command.substring(58);
                while (remaining.length > 0) {
                    console.log(`│ ${padToVisualWidth(remaining.substring(0, 58), 58)} │`);
                    remaining = remaining.substring(58);
                }
            }
            console.log('└────────────────────────────────────────────────────────────┘\n');

            // Use the UI interface for readline
            this.ui.question('Do you want to execute this command? (Y/N): ', (answer) => {
                const confirmed = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
                console.log(''); // Empty line for spacing
                resolve(confirmed);
            });
        });
    }

    // Execute a shell command
    async execute({ command }) {
        if (!command) {
            throw new Error('No command provided to execute');
        }

        console.log('▶️  Tool execution start: ShellCommand');
        console.log('─'.repeat(76));
        console.log(`📝 Command: ${command}`);
        console.log('─'.repeat(76));

        // Ask for user confirmation
        const confirmed = await this.askConfirmation(command);

        if (!confirmed) {
            const message = '❌ Command execution cancelled by user';
            console.log('─'.repeat(76));
            console.log(message);
            console.log('─'.repeat(76));
            console.log('⏹️  Tool execution end: ShellCommand (cancelled)\n');
            return JSON.stringify({
                status: 'cancelled',
                message: message,
                command: command
            });
        }

        console.log('✅ User approved. Executing command...');
        console.log('─'.repeat(76));

        try {
            // Execute the command
            const output = execSync(command, {
                encoding: 'utf8',
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
                timeout: 30000, // 30 second timeout
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const result = {
                status: 'success',
                command: command,
                output: output.trim(),
                exitCode: 0
            };

            console.log('─'.repeat(76));
            console.log('Command completed successfully');
            if (output.trim()) {
                console.log('\nOutput:');
                console.log(output.trim());
            } else {
                console.log('(no output)');
            }
            console.log('─'.repeat(76));
            console.log('⏹️  Tool execution end: ShellCommand\n');

            // Show pause menu
            await this.showPauseMenu();

            return JSON.stringify(result, null, 2);

        } catch (error) {
            const result = {
                status: 'error',
                command: command,
                error: error.message,
                exitCode: error.status || 1,
                stderr: error.stderr ? error.stderr.toString() : '',
                stdout: error.stdout ? error.stdout.toString() : ''
            };

            console.log('─'.repeat(76));
            console.error('❌ Command failed:', error.message);
            if (result.stderr) {
                console.log('\nError Output:');
                console.log(result.stderr);
            }
            if (result.stdout) {
                console.log('\nStandard Output:');
                console.log(result.stdout);
            }
            console.log('─'.repeat(76));
            console.log('⏹️  Tool execution end: ShellCommand (error)\n');

            // Show pause menu even on error
            await this.showPauseMenu();

            return JSON.stringify(result, null, 2);
        }
    }

    // Get tool metadata for LLM function calling
    getMetadata() {
        return {
            name: this.name,
            description: this.description,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Shell command to execute (30-sec timeout, user confirmation required). SAFETY: Prefer safe read-only commands (ls, cat, grep, find, pwd, whoami, df, ps). AVOID destructive operations (rm -rf, dd, mkfs). Use specific paths, not wildcards with write operations. Examples: "ls -la /home/user/docs", "cat config.json", "grep -r pattern .", "find . -name *.txt", "df -h".'
                    }
                },
                required: ['command']
            }
        };
    }
}

// ThinkTool - Allows the AI to process complex thoughts, reasoning, and analysis internally
class ThinkTool {
    constructor() {
        this.name = 'Think';
        this.description = `Allows the AI to process complex thoughts, reasoning, and analysis internally before providing responses.
Use this tool for deep contemplation, problem-solving, weighing multiple approaches, or when you need
to think through intricate logic before taking action. Essential for thorough analysis and well-reasoned decisions.

Examples:
- Analyze multiple solution approaches before implementing
- Reason through complex problem requirements
- Weigh pros and cons of different technical decisions
- Process and organize thoughts before generating code

This tool helps ensure well-thought-out responses and decisions by providing a space for internal reasoning.`;
    }

    // Execute the thinking process
    async execute({ thought }) {
        try {
            if (!thought || typeof thought !== 'string' || thought.trim().length === 0) {
                throw new Error('thought parameter is required and cannot be empty.');
            }
            return 'Thought processed internally. Ready to proceed with analysis and decision-making.';

        } catch (error) {
            console.error('[Think] Error:', error.message);
            throw new Error(`An error occurred while processing thoughts: ${error.message}`);
        }
    }

    // Get tool metadata for LLM function calling
    getMetadata() {
        return {
            name: this.name,
            description: this.description,
            parameters: {
                type: 'object',
                properties: {
                    thought: {
                        type: 'string',
                        description: 'The reasoning, analysis, or complex thoughts to process internally'
                    }
                },
                required: ['thought']
            }
        };
    }
}

module.exports = { JavaScriptTool, ShellCommandTool, ThinkTool };
