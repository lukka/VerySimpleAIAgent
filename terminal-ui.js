// Terminal UI Manager - Virtual terminal with fixed panels
//
// Performance optimizations:
// - Smart rendering: only redraws when content actually changes
// - Debounced rendering with setImmediate to batch updates
// - Padding cache for efficient string operations
// - Supports any terminal width/height without limits
//
// Usage: new TerminalUI()

const readline = require('readline');
const { getVisualWidth, wrapText } = require('./utils');

// ANSI color codes for background colors
const BG_COLORS = {
    RESET: '\x1b[0m',
    BLACK: '\x1b[40m',
    WHITE: '\x1b[47m\x1b[30m',      // White background with black text
    LIGHT_GRAY: '\x1b[47m\x1b[30m',  // Light gray background with black text
    BLUE: '\x1b[44m\x1b[37m',        // Blue background with white text
    GREEN: '\x1b[42m\x1b[30m',       // Green background with black text
    YELLOW: '\x1b[43m\x1b[30m',      // Yellow background with black text
    RED: '\x1b[41m\x1b[37m',         // Red background with white text
    CYAN: '\x1b[46m\x1b[30m',        // Cyan background with black text
    MAGENTA: '\x1b[45m\x1b[37m',     // Magenta background with white text
};

class TerminalUI {
    constructor(options = {}) {
        // Use full terminal width without limits
        this.width = process.stdout.columns || 80;
        this.height = process.stdout.rows || 24;

        // Algorithm panel (top frame) is fixed - shows the agent algorithm
        this.algorithmPanelHeight = 11;
        // Input line takes 1 row
        this.inputLineHeight = 1;

        // Bottom panel (Agent UI) has fixed height of 10 lines
        this.bottomPanelHeight = 10;

        // Process logs panel gets remaining space
        const remainingHeight = this.height - this.algorithmPanelHeight - this.inputLineHeight - this.bottomPanelHeight;
        this.topPanelHeight = remainingHeight;

        this.separatorRow = this.topPanelHeight + 1;

        // Buffer for panel content
        this.algorithmPanelLines = []; // Algorithm display (top frame)
        this.topPanelLines = []; // Process logs (middle)
        this.bottomPanelLines = []; // UI (bottom)
        this.inputLine = '';

        // Rendering optimization - track what changed
        this.lastRenderedOutput = null;
        this.renderPending = false;
        this.renderScheduled = false;

        // Current background color for new lines
        this.currentBgColor = BG_COLORS.RESET;

        // Scroll position for top panel (0 = show latest)
        this.topPanelScroll = 0;

        // Scroll position for bottom panel (0 = show latest)
        this.bottomPanelScroll = 0;

        // Activity indicator (animated character)
        this.activityIndicator = null;
        this.activityInterval = null;
        this.activityFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.activityFrameIndex = 0;

        // Blinking cursor for input prompt
        this.cursorVisible = true;
        this.cursorInterval = null;

        // Track if we're in question mode (for INSPECT menus, etc.)
        this.inQuestionMode = false;
        this.questionText = '';

        // Thinking animation (simple rotating character)
        this.thinkingAnimation = null;
        this.thinkingInterval = null;
        this.thinkingFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.thinkingFrameIndex = 0;

        // Message status indicator for Agent ↔ LLM communication
        // Values: 'sending', 'receiving', or null (idle)
        this.messageAnimation = null;
        this.messageAnimationFrame = 0;
        this.messageAnimationInterval = null;

        // Setup readline without automatic prompt
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });

        // Disable default readline output
        this.rl.output = null;

        // Handle terminal resize
        process.stdout.on('resize', () => {
            // Store previous dimensions to detect actual changes
            const prevWidth = this.width;
            const prevHeight = this.height;
            
            // Use full terminal size
            this.width = process.stdout.columns || 80;
            this.height = process.stdout.rows || 24;

            // Only recalculate and render if dimensions actually changed
            if (this.width !== prevWidth || this.height !== prevHeight) {
                // Recalculate panel heights (algorithm is fixed at 11, bottom panel fixed at 10, process logs gets remainder)
                this.algorithmPanelHeight = 11;
                this.inputLineHeight = 1;
                this.bottomPanelHeight = 10;

                const remainingHeight = this.height - this.algorithmPanelHeight - this.inputLineHeight - this.bottomPanelHeight;
                this.topPanelHeight = remainingHeight;

                this.separatorRow = this.topPanelHeight + 1;
                
                // Clear padding cache since width changed
                if (this.paddingCache) {
                    this.paddingCache.clear();
                }
                
                this.render();
            }
        });

        // Initialize screen first (must come before setupInput)
        this.init();
        
        // Setup input handling after screen is initialized
        this.setupInput();
    }

    init() {
        // Switch to alternate screen buffer first (prevents main buffer scroll)
        process.stdout.write('\x1b[?1049h'); // Enable alternative screen buffer
        process.stdout.write('\x1b[?47h'); // Enable alternate screen (additional support)
        process.stdout.write('\x1b[r'); // Reset scrolling region (disable scrollback in alt buffer)
        
        // Clear screen and hide cursor
        process.stdout.write('\x1b[2J'); // Clear screen
        process.stdout.write('\x1b[H'); // Move cursor to home
        process.stdout.write('\x1b[?25l'); // Hide cursor (we'll use our own blinking cursor)

        // Start cursor blinking interval
        this.cursorInterval = setInterval(() => {
            this.cursorVisible = !this.cursorVisible;
            this.updateCursor();
        }, 500); // Blink every 500ms

        // Load algorithm immediately at startup (synchronously)
        this.loadAlgorithmSync();

        // Initialize with a placeholder visualization
        const colors = {
            green: '\x1b[32m',
            cyan: '\x1b[36m',
            blue: '\x1b[34m',
            yellow: '\x1b[33m',
            magenta: '\x1b[35m',
            reset: '\x1b[0m'
        };
        
        this.savedVisualization = [
            `📊 ${colors.green}■${colors.reset}System:0 ${colors.cyan}■${colors.reset}Tools:0 ${colors.blue}■${colors.reset}User:0 ${colors.yellow}■${colors.reset}Asst:0 ${colors.magenta}■${colors.reset}Res:0 | Total: 0 tokens`
        ];

        // Initialize top panel with welcome message (enough lines to test scrolling)
        this.addToTopPanel('');
        this.addToTopPanel('Welcome to VerySimpleAgent! 🤖');
        this.addToTopPanel('');
        this.addToTopPanel('The agent\'s internal reasoning and prompt building will be displayed here as it works.');
        this.addToTopPanel('');
        this.addToTopPanel('You can scroll through the content using your "mouse wheel" gesture.');
        this.addToTopPanel('');

        this.render();
    }

    cleanup() {
        // Stop activity indicator if running
        if (this.activityInterval) {
            clearInterval(this.activityInterval);
            this.activityInterval = null;
        }

        // Stop thinking animation if running
        if (this.thinkingInterval) {
            clearInterval(this.thinkingInterval);
            this.thinkingInterval = null;
        }

        // Stop cursor blinking if running
        if (this.cursorInterval) {
            clearInterval(this.cursorInterval);
            this.cursorInterval = null;
        }

        // Stop message animation if running
        if (this.messageAnimationInterval) {
            clearInterval(this.messageAnimationInterval);
            this.messageAnimationInterval = null;
        }

        // Disable mouse tracking
        process.stdout.write('\x1b[?1004l'); // Disable focus events
        process.stdout.write('\x1b[?1000l');
        process.stdout.write('\x1b[?1002l');
        process.stdout.write('\x1b[?1006l');

        // Show cursor and restore screen
        process.stdout.write('\x1b[?25h'); // Show cursor
        process.stdout.write('\x1b[?47l'); // Disable alternate screen
        process.stdout.write('\x1b[?1049l'); // Disable alternative screen buffer
        process.stdout.write('\x1b[2J'); // Clear screen
        process.stdout.write('\x1b[H'); // Move cursor to home
    }

    setupInput() {
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        // Enable mouse tracking (must be done AFTER alternate screen is active)
        process.stdout.write('\x1b[?1000h'); // Enable mouse button tracking  
        process.stdout.write('\x1b[?1002h'); // Enable button event tracking (includes drag)
        process.stdout.write('\x1b[?1006h'); // Enable SGR extended mouse mode
        
        // Request focus events (helps ensure terminal is in app mode)
        process.stdout.write('\x1b[?1004h');

        stdin.on('data', (key) => {
            // Handle mouse events (SGR format: \x1b[<button;col;row;M or m)
            if (key.startsWith('\x1b[<')) {
                const match = key.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
                if (match) {
                    const button = parseInt(match[1]);
                    const col = parseInt(match[2]);
                    const row = parseInt(match[3]);
                    const pressed = match[4] === 'M';

                    // Mouse wheel: button 64 = scroll up, button 65 = scroll down
                    if (button === 64 && pressed) {
                        // Determine which panel based on row
                        // Layout: Algorithm Panel (1 to algorithmPanelHeight), Process Logs Panel, UI Panel
                        const firstPanelEnd = this.algorithmPanelHeight;
                        const secondPanelEnd = firstPanelEnd + this.topPanelHeight;
                        
                        if (row > firstPanelEnd && row <= secondPanelEnd) {
                            this.scrollUp();
                        } else if (row > secondPanelEnd) {
                            this.scrollUpBottom();
                        }
                        return;
                    } else if (button === 65 && pressed) {
                        // Determine which panel based on row
                        const firstPanelEnd = this.algorithmPanelHeight;
                        const secondPanelEnd = firstPanelEnd + this.topPanelHeight;
                        
                        if (row > firstPanelEnd && row <= secondPanelEnd) {
                            this.scrollDown();
                        } else if (row > secondPanelEnd) {
                            this.scrollDownBottom();
                        }
                        return;
                    }
                }
            }

            // Handle special keys
            if (key === '\u0003') { // Ctrl+C
                this.cleanup();
                process.exit(0);
            } else if (key === '\r' || key === '\n') { // Enter
                const input = this.inputLine;
                this.inputLine = '';
                this.render();
                // Always emit 'line' event (even for empty input)
                // The handlers will decide whether to process it
                this.emit('line', input);
            } else if (key === '\u007f') { // Backspace
                this.inputLine = this.inputLine.slice(0, -1);
                this.render();
            } else if ((key >= ' ' && key <= '~') || key.charCodeAt(0) > 127) { // Printable characters
                this.inputLine += key;
                this.render();
            }
            // Ignore other control characters and mouse events
        });
    }

    // Event emitter pattern
    emit(event, data) {
        if (this.listeners && this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }

    on(event, callback) {
        if (!this.listeners) this.listeners = {};
        if (!this.listeners[event]) this.listeners[event] = [];

        // Prevent duplicate registration of the same callback
        if (!this.listeners[event].includes(callback)) {
            this.listeners[event].push(callback);
        }
    }

    // Add text to top panel
    addToTopPanel(text) {
        const contentWidth = this.width - 2; // Account for left/right borders
        const wrappedLines = wrapText(text, contentWidth);

        for (const line of wrappedLines) {
            // Add line directly with current background color
            this.topPanelLines.push({
                text: line,
                bgColor: this.currentBgColor
            });
        }

        // Auto-scroll to bottom when new content is added (only if already at bottom)
        if (this.topPanelScroll === 0) {
            // Keep only the last lines that fit (plus some history for scrolling)
            const maxLines = (this.topPanelHeight - 2) * 10; // Keep 10x the visible area
            if (this.topPanelLines.length > maxLines) {
                this.topPanelLines = this.topPanelLines.slice(-maxLines);
            }
        }

        this.render();
    }

    // Update prompt visualization (stored but not displayed in algorithm panel)
    updatePromptVisualization(visualizationLines) {
        // This method is called to update token visualization
        // It should NOT modify the algorithm panel (algorithmPanelLines) which shows the algorithm
        // The algorithm panel is only updated by updateDebugContextWithLocation() during breakpoints
        
        // Store visualization for later use if needed
        this.savedVisualization = [...visualizationLines];
        
        // Don't modify algorithmPanelLines here - it's reserved for the algorithm display
        // The algorithm is updated by breakpoint() -> updateDebugContextWithLocation()
        
        // Optionally render to update other panels if needed
        this.render();
    }

    // Initialize visualization with actual system and tool tokens from agent
    // Also updates the visualization based on current conversation history
    initializeVisualizationFromAgent(agent) {
        const { estimateTokens } = require('./utils');

        // Calculate tokens from agent's persistent data sources
        const systemTokens = estimateTokens(agent.systemPrompt || '');
        const toolSchemas = agent.tools.map(tool => tool.getMetadata());
        const toolTokens = estimateTokens(JSON.stringify(toolSchemas));
        
        // Calculate tokens from conversation history using agent's method
        const { userTokens, assistantTokens, toolResultTokens } = agent.calculateTokensByRole();

        // Use agent's visualization method to build the lines
        const { line1, line2 } = agent.buildVisualizationLines(
            systemTokens, toolTokens, userTokens, assistantTokens, toolResultTokens
        );

        // Update saved visualization
        this.savedVisualization = [line1, line2];

        // Don't modify algorithmPanelLines here - it's reserved for the algorithm display
        // The algorithm is only updated by breakpoint() -> updateDebugContextWithLocation()

        this.render();
    }

    // Set background color for subsequent text
    setBgColor(colorName) {
        this.currentBgColor = BG_COLORS[colorName] || BG_COLORS.RESET;
    }

    // Reset background color to default
    resetBgColor() {
        this.currentBgColor = BG_COLORS.RESET;
    }

    // Scroll up in top panel (show older content)
    scrollUp() {
        const contentLinesAvailable = (this.topPanelHeight - 2) - 1; // -2 for borders, -1 for Agent/LLM indicator
        const maxScroll = Math.max(0, this.topPanelLines.length - contentLinesAvailable);
        if (this.topPanelScroll < maxScroll) {
            this.topPanelScroll++;
            this.render();
        }
    }

    // Scroll down in top panel (show newer content)
    scrollDown() {
        if (this.topPanelScroll > 0) {
            this.topPanelScroll--;
            this.render();
        }
    }

    // Scroll to bottom (show latest content)
    scrollToBottom() {
        if (this.topPanelScroll !== 0) {
            this.topPanelScroll = 0;
            this.render();
        }
    }

    // Scroll up in bottom panel (show older content)
    // Scroll up in bottom panel (show older content)
    scrollUpBottom() {
        const maxScroll = Math.max(0, this.bottomPanelLines.length - (this.bottomPanelHeight - 2));
        if (this.bottomPanelScroll < maxScroll) {
            this.bottomPanelScroll++;
            this.render();
        }
    }

    // Scroll down in bottom panel (show newer content)
    scrollDownBottom() {
        if (this.bottomPanelScroll > 0) {
            this.bottomPanelScroll--;
            this.render();
        }
    }

    // Clear top panel
    clearTopPanel() {
        this.topPanelLines = [];
        this.render();
    }

    // Replace last N lines in top panel
    replaceLastTopPanelLines(count, newLines) {
        // Remove last N lines
        if (this.topPanelLines.length >= count) {
            this.topPanelLines.splice(-count, count);
        }
        
        // Add new lines
        const contentWidth = this.width - 2;
        for (const text of newLines) {
            const wrappedLines = wrapText(text, contentWidth);
            for (const line of wrappedLines) {
                this.topPanelLines.push({
                    text: line,
                    bgColor: this.currentBgColor
                });
            }
        }
        
        this.render();
    }

    // Clear bottom panel
    clearBottomPanel() {
        this.bottomPanelLines = [];
        this.render();
    }

    // Truncate or pad text to fit width
    fitText(text, width, bgColor = BG_COLORS.RESET) {
        const visualWidth = getVisualWidth(text);
        if (visualWidth > width) {
            // Truncate - preserve ANSI codes while counting only visible characters
            let result = '';
            let currentWidth = 0;
            let i = 0;
            
            while (i < text.length && currentWidth < width) {
                // Check for ANSI escape sequence
                if (text[i] === '\x1b' && text[i+1] === '[') {
                    // Find end of ANSI sequence (ends with 'm')
                    let j = i + 2;
                    while (j < text.length && text[j] !== 'm') {
                        j++;
                    }
                    // Include the ANSI sequence without counting its width
                    result += text.substring(i, j + 1);
                    i = j + 1;
                } else {
                    // Regular character - count its width
                    const char = text[i];
                    const charWidth = getVisualWidth(char);
                    if (currentWidth + charWidth > width) break;
                    result += char;
                    currentWidth += charWidth;
                    i++;
                }
            }
            const paddingNeeded = width - currentWidth;
            const padding = this.getPadding(paddingNeeded);
            return bgColor + result + padding + BG_COLORS.RESET;
        } else {
            // Pad with spaces maintaining the background color
            const paddingNeeded = width - visualWidth;
            const padding = this.getPadding(paddingNeeded);
            return bgColor + text + padding + BG_COLORS.RESET;
        }
    }

    // Generate scroll indicator border for a panel
    // Returns the top border string with optional scroll indicator
    generateScrollBorder(panelTitle, totalLines, scrollableLines, currentScroll) {
        // Ensure minimum width to prevent errors
        if (this.width < 10) {
            return '┌──────┐'; // Fallback for very narrow terminals
        }

        let border;

        if (totalLines > scrollableLines) {
            // Show both title and scroll indicator
            const maxScroll = Math.max(1, totalLines - scrollableLines);
            const scrollPercent = currentScroll === 0 ? ' END' :
                                  (Math.round((currentScroll / maxScroll) * 100) + '%').padStart(4, ' ');
            const scrollInfo = ` [${scrollPercent}] `;

            // Calculate positions: title on left, scroll on right (use visual width for emojis)
            const titleWidth = getVisualWidth(panelTitle);
            const scrollWidth = getVisualWidth(scrollInfo);
            
            // Ensure we have space for at least the borders, title, and scroll info
            if (titleWidth + scrollWidth + 2 > this.width) {
                // Not enough space - just show a simple border
                const dashCount = Math.max(0, this.width - 2);
                border = '┌' + '─'.repeat(dashCount) + '┐';
            } else {
                const middleSpace = Math.max(0, this.width - 2 - titleWidth - scrollWidth);
                border = '┌' + panelTitle + '─'.repeat(middleSpace) + scrollInfo + '┐';
            }
        } else {
            // Just show title (use visual width)
            const titleWidth = getVisualWidth(panelTitle);
            if (titleWidth + 2 > this.width) {
                // Title too long - show simple border
                const dashCount = Math.max(0, this.width - 2);
                border = '┌' + '─'.repeat(dashCount) + '┐';
            } else {
                const dashCount = Math.max(0, this.width - 2 - titleWidth);
                border = '┌' + panelTitle + '─'.repeat(dashCount) + '┐';
            }
        }

        return border;
    }

    // Render the entire UI
    render() {
        // Debounce rendering - schedule it for next tick if not already scheduled
        if (this.renderScheduled) return;
        
        this.renderScheduled = true;
        setImmediate(() => {
            this.renderScheduled = false;
            this.doRender();
        });
    }

    // Force immediate render without debouncing
    renderImmediate() {
        this.renderScheduled = false;
        this.doRender();
    }

    // Update only the activity indicator without full redraw
    updateActivityIndicator() {
        if (!this.activityIndicator) return;
        
        // Calculate the row where activity indicator appears (bottom of second panel)
        const activityRow = this.algorithmPanelHeight + this.topPanelHeight;
        
        // Build the border line with activity indicator (just the spinner, no label)
        const indicator = ` ${this.activityFrames[this.activityFrameIndex]} `;
        const indicatorWidth = getVisualWidth(indicator);
        const availableSpace = Math.max(0, this.width - 2 - indicatorWidth);
        const leftPadding = Math.floor(availableSpace / 2);
        const rightPadding = availableSpace - leftPadding;
        const borderLine = '└' + '─'.repeat(leftPadding) + indicator + '─'.repeat(rightPadding) + '┘';
        
        // Move to the row and write the updated border
        process.stdout.write(`\x1b[${activityRow};1H${borderLine}`);
    }

    // Update only the thinking indicator without full redraw
    updateThinkingIndicator() {
        if (!this.thinkingAnimation) return;
        
        // Find the last line in bottom panel
        const bottomContentHeight = this.bottomPanelHeight - 2;
        const bottomStartIndex = Math.max(0, this.bottomPanelLines.length - bottomContentHeight - this.bottomPanelScroll);
        const lastVisibleIndex = this.bottomPanelLines.length - 1 - this.bottomPanelScroll;
        
        if (lastVisibleIndex < bottomStartIndex) return;
        
        // Calculate row position
        const lineIndexInPanel = lastVisibleIndex - bottomStartIndex;
        const thinkingRow = this.algorithmPanelHeight + this.topPanelHeight + 2 + lineIndexInPanel;
        
        // Get the line text
        const lineObj = this.bottomPanelLines[lastVisibleIndex];
        if (!lineObj) return;
        
        let lineText = lineObj.text;
        const thinkingChar = this.thinkingFrames[this.thinkingFrameIndex];
        lineText = lineText + ' ' + thinkingChar;
        
        // Build the line with white background
        const displayLine = this.fitText(lineText, this.width - 2, BG_COLORS.WHITE);
        
        // Move to the row and write the updated line
        process.stdout.write(`\x1b[${thinkingRow};2H${displayLine}`);
    }

    // Actual render implementation
    updateCursor() {
        // Only update the cursor character without redrawing the entire screen
        // This prevents flickering from cursor blinks
        
        // Calculate cursor position on screen
        // The input line is at the bottom (row = height)
        const cursorRow = this.height;
        
        // Calculate cursor column position
        const prompt = '🐱 You: ';
        const promptLength = getVisualWidth(prompt);
        const inputLength = getVisualWidth(this.inputLine);
        const cursorCol = promptLength + inputLength + 1; // +1 for 1-indexed
        
        // Move to cursor position and write cursor character
        const cursor = this.cursorVisible ? '█' : ' ';
        process.stdout.write(`\x1b[${cursorRow};${cursorCol}H${cursor}`);
        
        // For question mode cursor in top panel
        if (this.inQuestionMode && this.questionText) {
            // Find the line with the question in top panel
            const lines = this.topPanelLines;
            const totalLines = lines.length;
            const topPanelVisibleLines = this.topPanelHeight - 3; // -2 for borders, -1 for Agent/LLM indicator
            
            // The question is typically on the last line
            for (let i = totalLines - 1; i >= Math.max(0, totalLines - topPanelVisibleLines); i--) {
                const lineObj = lines[i];
                if (lineObj && lineObj.text.includes(this.questionText.trim())) {
                    // Calculate row in top panel (after algorithm panel)
                    const algorithmPanelRows = this.algorithmPanelHeight;
                    const visibleStart = Math.max(0, totalLines - topPanelVisibleLines - this.topPanelScroll);
                    const lineIndex = i - visibleStart;
                    const questionRow = algorithmPanelRows + 2 + lineIndex; // +2 for top panel border and 1-indexed
                    
                    // Calculate column at end of question text
                    const questionCol = 1 + getVisualWidth(lineObj.text) + 1;
                    
                    // Write cursor at question position
                    const questionCursor = this.cursorVisible ? '█' : ' ';
                    process.stdout.write(`\x1b[${questionRow};${questionCol}H${questionCursor}`);
                    break;
                }
            }
        }
    }

    doRender() {
        const output = [];

        // Build the output first
        output.push('\x1b[1;1H'); // Move to top-left (no clear screen)

        // ===== FIRST PANEL: Agent Algorithm (top frame, fixed height) =====
        const firstPanelTitle = ' 🤖 VerySimpleAgent Algorithm ';
        const firstTitleWidth = getVisualWidth(firstPanelTitle);
        const firstDashCount = Math.max(0, this.width - 2 - firstTitleWidth);
        const firstPanelBorder = '┌' + firstPanelTitle + '─'.repeat(firstDashCount) + '┐';
        output.push(firstPanelBorder);

        // First panel content (fixed height, no scrolling)
        const firstPanelContentHeight = this.algorithmPanelHeight - 2;
        const firstPanelContentWidth = this.width - 2;
        
        for (let i = 0; i < firstPanelContentHeight; i++) {
            const line = this.algorithmPanelLines[i] || '';
            
            // Use fitText to properly handle padding and truncation with ANSI codes
            const displayLine = this.fitText(line, firstPanelContentWidth, BG_COLORS.RESET);
            
            output.push('│' + displayLine + '│');
        }

        // First panel bottom border
        const firstBottomDashes = Math.max(0, this.width - 2);
        output.push('└' + '─'.repeat(firstBottomDashes) + '┘');

        // ===== SECOND PANEL: Agent Internal Process Logs (scrollable) =====
        const title = ' VerySimpleAgent Internal Process Logs ';
        const topScrollableLines = (this.topPanelHeight - 2) - 1; // -2 for borders, -1 for Agent/LLM indicator
        const topBorder = this.generateScrollBorder(title, this.topPanelLines.length, topScrollableLines, this.topPanelScroll);
        output.push(topBorder);

        // Second panel content (scrollable with Agent/LLM indicator at bottom)
        // Reserve 1 line for Agent/LLM indicator
        const topContentHeight = this.topPanelHeight - 2;
        const contentLinesAvailable = topContentHeight - 1; // Reserve 1 line for Agent/LLM indicator
        const totalLines = this.topPanelLines.length;

        // Calculate which lines to show based on scroll position
        // scroll = 0 means show the latest (bottom of buffer)
        // scroll > 0 means show older content
        const startIndex = Math.max(0, totalLines - contentLinesAvailable - this.topPanelScroll);
        const endIndex = startIndex + contentLinesAvailable;

        // Render content lines (all except the last reserved line)
        for (let i = 0; i < contentLinesAvailable; i++) {
            const lineIndex = startIndex + i;
            const lineObj = this.topPanelLines[lineIndex];

            if (lineObj) {
                const lineText = lineObj.text;

                // No background color for top panel
                output.push('│' + this.fitText(lineText, this.width - 2, BG_COLORS.RESET) + '│');
            } else {
                output.push('│' + this.fitText('', this.width - 2) + '│');
            }
        }

        // Always render the Agent/LLM indicator (1 line tall) at the bottom
        let statusLine;
        if (this.messageAnimation === 'sending') {
            // Left to right animation: colors flow from left to right
            const colors = ['\x1b[90m', '\x1b[37m', '\x1b[97m', '\x1b[37m', '\x1b[90m']; // dark gray -> light gray -> bright white -> light gray -> dark gray
            const frame = this.messageAnimationFrame % 5;
            const arrow1 = colors[(frame + 0) % 5] + '░' + '\x1b[0m';
            const arrow2 = colors[(frame + 1) % 5] + '▒' + '\x1b[0m';
            const arrow3 = colors[(frame + 2) % 5] + '▓' + '\x1b[0m';
            const arrow4 = colors[(frame + 3) % 5] + '█' + '\x1b[0m';
            const arrow5 = colors[(frame + 4) % 5] + '▶' + '\x1b[0m';
            statusLine = `🤖 Agent  ${arrow1}${arrow2}${arrow3}${arrow4}${arrow5}  Sending to LLM 🧠 ...`;
        } else if (this.messageAnimation === 'receiving') {
            // Right to left animation: colors flow from right to left
            const colors = ['\x1b[90m', '\x1b[37m', '\x1b[97m', '\x1b[37m', '\x1b[90m']; // dark gray -> light gray -> bright white -> light gray -> dark gray
            const frame = this.messageAnimationFrame % 5;
            const arrow1 = colors[(frame + 4) % 5] + '◀' + '\x1b[0m';
            const arrow2 = colors[(frame + 3) % 5] + '█' + '\x1b[0m';
            const arrow3 = colors[(frame + 2) % 5] + '▓' + '\x1b[0m';
            const arrow4 = colors[(frame + 1) % 5] + '▒' + '\x1b[0m';
            const arrow5 = colors[(frame + 0) % 5] + '░' + '\x1b[0m';
            statusLine = `🤖 Agent  ${arrow1}${arrow2}${arrow3}${arrow4}${arrow5}  Received response from LLM 🧠`;
        } else {
            statusLine = '🤖 Agent     LLM 🧠';
        }
        
        const contentWidth = this.width - 2;
        const paddedStatusLine = this.fitText(statusLine, contentWidth, BG_COLORS.RESET);
        output.push('│' + paddedStatusLine + '│');

        // Second panel bottom border with activity indicator
        let secondPanelBottomBorder;
        if (this.activityIndicator) {
            // Add activity indicator in the middle of bottom border (just spinner, no label)
            const indicator = ` ${this.activityFrames[this.activityFrameIndex]} `;
            const indicatorWidth = getVisualWidth(indicator);
            const availableSpace = Math.max(0, this.width - 2 - indicatorWidth);
            const leftPadding = Math.floor(availableSpace / 2);
            const rightPadding = availableSpace - leftPadding;
            secondPanelBottomBorder = '└' + '─'.repeat(leftPadding) + indicator + '─'.repeat(rightPadding) + '┘';
        } else {
            const bottomDashes = Math.max(0, this.width - 2);
            secondPanelBottomBorder = '└' + '─'.repeat(bottomDashes) + '┘';
        }
        output.push(secondPanelBottomBorder);

        // ===== THIRD PANEL: Agent UI (scrollable) =====
        const bottomTitle = ' Agent UI ';
        const bottomScrollableLines = this.bottomPanelHeight - 2;
        const bottomBorder = this.generateScrollBorder(bottomTitle, this.bottomPanelLines.length, bottomScrollableLines, this.bottomPanelScroll);
        output.push(bottomBorder);

        // Bottom panel content with scroll support
        const bottomContentHeight = this.bottomPanelHeight - 2;
        const bottomStartIndex = Math.max(0, this.bottomPanelLines.length - bottomContentHeight - this.bottomPanelScroll);
        const bottomEndIndex = this.bottomPanelLines.length - this.bottomPanelScroll;

        for (let i = 0; i < bottomContentHeight; i++) {
            const lineIndex = bottomStartIndex + i;
            const lineObj = lineIndex >= 0 && lineIndex < bottomEndIndex ? this.bottomPanelLines[lineIndex] : null;
            if (lineObj) {
                let lineText = lineObj.text;
                
                // If this is the last line and thinking animation is active, append it
                if (this.thinkingAnimation && lineIndex === this.bottomPanelLines.length - 1) {
                    const thinkingChar = this.thinkingFrames[this.thinkingFrameIndex];
                    lineText = lineText + ' ' + thinkingChar;
                }
                
                // White background with black text for bottom panel
                output.push('│' + this.fitText(lineText, this.width - 2, BG_COLORS.WHITE) + '│');
            } else {
                output.push('│' + this.fitText('', this.width - 2, BG_COLORS.WHITE) + '│');
            }
        }

        // Bottom panel bottom border
        const bottomDashes = Math.max(0, this.width - 2);
        output.push('└' + '─'.repeat(bottomDashes) + '┘');

        // Input line with blinking cursor (at the very bottom)
        // Don't include the cursor in the output comparison to prevent redraws on blink
        const prompt = '🐱 You: ';
        const inputText = this.inputLine;
        const inputDisplay = prompt + inputText + ' '; // Always add space for cursor placeholder
        output.push(this.fitText(inputDisplay, this.width));

        // Join and compare with last render
        const newOutput = output.join('\r\n');
        
        // Only write if output changed (cursor is updated separately by updateCursor)
        if (newOutput !== this.lastRenderedOutput) {
            // Clear screen only on first render or size change
            if (this.lastRenderedOutput === null || this.lastRenderedOutput.length !== newOutput.length) {
                process.stdout.write('\x1b[2J'); // Clear screen
            }
            
            process.stdout.write(newOutput);
            this.lastRenderedOutput = newOutput;
            
            // After full render, update cursor position to show current state
            this.updateCursor();
        }

        // Keep cursor hidden (we're using our own blinking cursor character)
        process.stdout.write('\x1b[?25l');
    }

    // Display a message (compatibility with console.log)
    log(message) {
        // Add to top panel (always)
        this.addToTopPanel(message);

        // Also add to bottom panel if it's a User or Agent message
        if (message.includes('You:') || message.includes('🤖 Agent:')) {
            // If this is an agent message and we have a thinking line, replace it
            if (message.includes('🤖 Agent:') && this.currentThinkingMarker !== undefined) {
                // Strip the "🤖 Agent:" prefix and any whitespace, then prepend exactly what we want
                const contentWithoutPrefix = message.replace('🤖 Agent:', '').trim();
                
                this.replaceThinkingLine(contentWithoutPrefix);
            } else {
                // For "You:" messages, add directly to bottom panel (not through queue)
                // to maintain proper ordering with thinking lines
                const contentWidth = this.width - 2;
                const wrappedLines = wrapText(message, contentWidth);
                for (const line of wrappedLines) {
                    this.bottomPanelLines.push({
                        text: line,
                        bgColor: this.currentBgColor
                    });
                }
                // Trim if needed
                if (this.bottomPanelScroll === 0) {
                    const maxLines = (this.bottomPanelHeight - 2) * 10;
                    if (this.bottomPanelLines.length > maxLines) {
                        this.bottomPanelLines = this.bottomPanelLines.slice(-maxLines);
                    }
                }
            }
        }
    }

    // Ask a question (compatibility with readline)
    question(query, callback) {
        // Note: Animation is handled by startActivity() during actual sending/receiving
        // INSPECT menus don't trigger animation

        this.addToTopPanel(query);
        this.inQuestionMode = true;
        this.questionText = query;

        const handler = (input) => {
            this.removeListener('line', handler);
            this.inQuestionMode = false;
            this.questionText = '';
            callback(input);
        };
        this.on('line', handler);
    }

    // Remove listener
    removeListener(event, callback) {
        if (this.listeners && this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    // Start activity indicator animation
    startActivity(label) {
        this.activityIndicator = label;
        this.activityFrameIndex = 0;

        // Start message animation based on activity type
        if (label && label.includes('Sending')) {
            this.startMessageAnimation('left-to-right', '📤');
        } else if (label && label.includes('Receiving')) {
            this.startMessageAnimation('right-to-left', '📥');
        }

        // Start animation interval
        this.activityInterval = setInterval(() => {
            this.activityFrameIndex = (this.activityFrameIndex + 1) % this.activityFrames.length;
            this.updateActivityIndicator();
        }, 80); // Update every 80ms
    }

    // Stop activity indicator animation
    stopActivity() {
        if (this.activityInterval) {
            clearInterval(this.activityInterval);
            this.activityInterval = null;
        }
        this.activityIndicator = null;

        // Stop message animation when activity stops
        this.stopMessageAnimation();

        this.render();
    }

    // Start thinking animation (simple rotating character)
    startThinking(text = '') {
        if (this.thinkingInterval) {
            return; // Already running
        }
        
        this.thinkingAnimation = true; // Set to true instead of empty string
        this.thinkingFrameIndex = 0;
        
        // Create marker BEFORE adding the line
        const thinkingMarker = Symbol('thinking');
        this.currentThinkingMarker = thinkingMarker;
        
        // Add thinking line directly to bottomPanelLines (bypass queue for immediate marking)
        this.bottomPanelLines.push({
            text: '🤖 Agent:',
            bgColor: this.currentBgColor,
            thinkingMarker: thinkingMarker
        });
        
        this.thinkingInterval = setInterval(() => {
            this.thinkingFrameIndex = (this.thinkingFrameIndex + 1) % this.thinkingFrames.length;
            this.updateThinkingIndicator();
        }, 80); // Update every 80ms
    }

    // Stop thinking animation
    stopThinking() {
        if (this.thinkingInterval) {
            clearInterval(this.thinkingInterval);
            this.thinkingInterval = null;
        }
        this.thinkingAnimation = null;
        this.render();
    }

    // Replace the thinking line with content (used for agent response)
    replaceThinkingLine(text) {
        if (this.currentThinkingMarker) {
            // Find all lines with the thinking marker
            const markedIndices = [];
            for (let i = 0; i < this.bottomPanelLines.length; i++) {
                if (this.bottomPanelLines[i].thinkingMarker === this.currentThinkingMarker) {
                    markedIndices.push(i);
                }
            }
            
            if (markedIndices.length > 0) {
                // Ensure no leading/trailing whitespace or newlines
                // Replace ALL newlines and carriage returns with spaces so text flows naturally on one line
                // Also replace multiple spaces with single space
                const cleanedText = text
                    .replace(/^\s+|\s+$/g, '') // trim
                    .replace(/[\r\n]+/g, ' ')   // all newlines/carriage returns to spaces
                    .replace(/\s+/g, ' ');      // collapse multiple spaces
                
                // Prepend "🤖 Agent: " prefix to the content
                const fullText = '🤖 Agent: ' + cleanedText;
                
                // Replace the thinking line(s) with the new text
                const contentWidth = this.width - 2;
                const wrappedLines = wrapText(fullText, contentWidth);
                
                // Remove the old thinking line(s) (remove from highest index first)
                for (let i = markedIndices.length - 1; i >= 0; i--) {
                    this.bottomPanelLines.splice(markedIndices[i], 1);
                }
                
                // Insert wrapped lines at the position of the first marked line
                const insertIndex = markedIndices[0];
                for (let i = 0; i < wrappedLines.length; i++) {
                    this.bottomPanelLines.splice(insertIndex + i, 0, {
                        text: wrappedLines[i],
                        bgColor: this.currentBgColor
                    });
                }
                
                // Clear the marker
                this.currentThinkingMarker = undefined;
                this.render();
                return;
            }
        }
        
        // Fallback: just add normally if thinking line not found
        this.addToBottomPanel(text);
    }

    // Update only the message animation status line (avoid full screen redraw)
    updateMessageAnimationLine() {
        // Calculate the row where the Agent/LLM indicator is displayed
        // It's the last line of the Process Logs panel, before the bottom border
        // Algorithm: 14 rows, then Process Logs: top border + content + status line (last) + bottom border
        const statusRow = this.algorithmPanelHeight + this.topPanelHeight - 1; // -1 because status is before bottom border
        
        // Generate the status line content
        let statusLine;
        if (this.messageAnimation === 'sending') {
            const colors = ['\x1b[90m', '\x1b[37m', '\x1b[97m', '\x1b[37m', '\x1b[90m'];
            const frame = this.messageAnimationFrame % 5;
            const arrow1 = colors[(frame + 0) % 5] + '░' + '\x1b[0m';
            const arrow2 = colors[(frame + 1) % 5] + '▒' + '\x1b[0m';
            const arrow3 = colors[(frame + 2) % 5] + '▓' + '\x1b[0m';
            const arrow4 = colors[(frame + 3) % 5] + '█' + '\x1b[0m';
            const arrow5 = colors[(frame + 4) % 5] + '▶' + '\x1b[0m';
            statusLine = `🤖 Agent  ${arrow1}${arrow2}${arrow3}${arrow4}${arrow5}  Sending to LLM 🧠 ...`;
        } else if (this.messageAnimation === 'receiving') {
            const colors = ['\x1b[90m', '\x1b[37m', '\x1b[97m', '\x1b[37m', '\x1b[90m'];
            const frame = this.messageAnimationFrame % 5;
            const arrow1 = colors[(frame + 4) % 5] + '◀' + '\x1b[0m';
            const arrow2 = colors[(frame + 3) % 5] + '█' + '\x1b[0m';
            const arrow3 = colors[(frame + 2) % 5] + '▓' + '\x1b[0m';
            const arrow4 = colors[(frame + 1) % 5] + '▒' + '\x1b[0m';
            const arrow5 = colors[(frame + 0) % 5] + '░' + '\x1b[0m';
            statusLine = `🤖 Agent  ${arrow1}${arrow2}${arrow3}${arrow4}${arrow5}  Received response from LLM 🧠`;
        } else {
            statusLine = '🤖 Agent     LLM 🧠';
        }
        
        const contentWidth = this.width - 2;
        const displayLine = this.fitText(statusLine, contentWidth);
        
        // Move to the status line position and update only that line
        process.stdout.write(`\x1b[${statusRow};1H│${displayLine}│`);
    }

    // Start message status display
    // direction: 'left-to-right' (Agent->LLM sending) or 'right-to-left' (LLM->Agent receiving)
    startMessageAnimation(direction = 'left-to-right', icon = '📤') {
        if (direction === 'left-to-right') {
            this.messageAnimation = 'sending';
        } else {
            this.messageAnimation = 'receiving';
        }
        
        this.messageAnimationFrame = 0;
        
        // Start animation interval for color cycling
        if (this.messageAnimationInterval) {
            clearInterval(this.messageAnimationInterval);
        }
        
        this.messageAnimationInterval = setInterval(() => {
            this.messageAnimationFrame = (this.messageAnimationFrame + 1) % 5;
            this.updateMessageAnimationLine(); // Update only the animation line
        }, 100); // Update every 100ms
        
        this.render(); // Initial render
    }

    // Stop message status display
    stopMessageAnimation() {
        if (this.messageAnimationInterval) {
            clearInterval(this.messageAnimationInterval);
            this.messageAnimationInterval = null;
        }
        this.messageAnimation = null;
        this.messageAnimationFrame = 0;
        this.render();
    }

    // Show receiving message for 1 second
    async waitForAnimationCycle(direction = 'right-to-left', icon = '📥') {
        return new Promise((resolve) => {
            this.messageAnimation = 'receiving';
            this.render();
            
            setTimeout(() => {
                this.messageAnimation = null;
                this.render();
                resolve();
            }, 2500); // Show for 2.5 seconds
        });
    }

    // Read source code with context around a specific line
    async readSourceContext(filePath, lineNumber, contextLinesBefore = 3, contextLinesAfter = 3) {
        const fs = require('fs').promises;
        const path = require('path');

        try {
            // Resolve relative paths
            const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
            const content = await fs.readFile(absPath, 'utf-8');
            const lines = content.split('\n');

            const startLine = Math.max(0, lineNumber - contextLinesBefore - 1);
            const endLine = Math.min(lines.length, lineNumber + contextLinesAfter);

            // ANSI codes for inverted text (reverse video)
            const invert = '\x1b[7m';
            const reset = '\x1b[0m';

            const sourceLines = [];
            for (let i = startLine; i < endLine; i++) {
                const lineNum = i + 1;
                const isCurrentLine = lineNum === lineNumber;
                const prefix = isCurrentLine ? '→' : ' ';
                const truncatedLine = lines[i].substring(0, this.width - 10); // Leave space for line number and prefix
                const lineText = `${prefix}${lineNum}: ${truncatedLine}`;

                // Apply inverted text to current line
                if (isCurrentLine) {
                    sourceLines.push(`${invert}${lineText}${reset}`);
                } else {
                    sourceLines.push(lineText);
                }
            }

            return sourceLines;
        } catch (error) {
            return [`Error reading file: ${error.message}`];
        }
    }

    // Update algorithm highlighting based on current phase (called by breakpoint)
    async updateDebugContextWithLocation(filePath, lineNumber, phaseName = 'Current Phase') {
        try {
            // Update highlighting without rebuilding the entire panel
            this.highlightAlgorithmPhase(phaseName);
            this.render();
        } catch (error) {
            // Show detailed error information for debugging
            const errorLines = [
                '⚠️ Debug Context Error',
                '',
                `Error: ${error.message}`,
                '',
                `Phase: ${phaseName}`,
                `File: ${filePath}`,
                `Line: ${lineNumber || 'auto-detect'}`,
                '',
                'Stack trace:',
                error.stack || 'No stack trace available'
            ];
            
            // Show error in algorithm panel
            this.algorithmPanelLines = errorLines;
            this.render();
        }
    }

    // Format file reference that VS Code terminal recognizes as clickable
    formatFileReference(text, filePath, lineNumber, skipLink = false) {
        // VS Code terminal auto-detects patterns like [filename:line] and makes them clickable
        // Format: content [filename:line] (right-aligned to keep algorithm left-aligned)
        const fileName = require('path').basename(filePath);
        const fileRef = `[${fileName}:${lineNumber}]`;
        
        // If skipLink is true, just return the text without file reference
        if (skipLink) {
            return text;
        }
        
        // Calculate padding to right-align the file reference
        const contentWidth = this.width - 4; // Account for panel borders (2 chars on each side)
        const textWidth = getVisualWidth(text);
        const fileRefWidth = getVisualWidth(fileRef);
        const totalWidth = textWidth + 1 + fileRefWidth; // +1 for space between
        
        if (totalWidth <= contentWidth) {
            // Add padding between text and file reference to right-align it
            const paddingNeeded = contentWidth - totalWidth;
            return text + ' '.repeat(paddingNeeded + 1) + fileRef;
        } else {
            // Not enough space - just show text with file reference (may wrap or truncate)
            return `${text} ${fileRef}`;
        }
    }

    // Load algorithm once at startup (no highlighting)
    loadAlgorithmSync() {
        const fs = require('fs');
        const path = require('path');

        try {
            const agentFilePath = path.join(__dirname, 'agent-node.js');
            const indexFilePath = path.join(__dirname, 'index.js');
            const content = fs.readFileSync(agentFilePath, 'utf-8');
            const lines = content.split('\n');

            // Algorithm is at lines 166-175 (1-indexed), which is 165-174 (0-indexed)
            const algoStartLine = 165;
            const algoEndLine = 174;

            // Map algorithm lines to their actual implementation line numbers
            // These are the lines AFTER the "// Phase:" comment (the actual code)
            const phaseLineMapping = {
                "wait for a user's question": { file: indexFilePath, line: 271 }, // Line after "// Phase: wait for a user's question" in index.js
                'chat_history.push(question)': { file: agentFilePath, line: 187 },      // Line after "// Phase: chat_history.push(question)"
                'response = llm.chat(prompt)': { file: agentFilePath, line: 252 },      // Line after "// Phase: response = llm.chat(prompt)"
                'if tool calls in response exist': { file: agentFilePath, line: 264 },  // Line after "// Phase: if tool calls in response exist"
                'result = tool.invoke()': { file: agentFilePath, line: 358 },           // Line after "// Phase: result = tool.invoke()" in executeToolCalls
                "prompt += tool's invocation + result": { file: agentFilePath, line: 274 }, // Line after "// Phase: prompt += tool's invocation + result"
                'chat_history.push(response)': { file: agentFilePath, line: 198 },      // Line after "// Phase: chat_history.push(response)"
                'display response': { file: agentFilePath, line: 209 }                   // Line after "// Phase: display response"
            };

            // Store the raw algorithm lines and file info
            this.rawAlgorithmLines = [];
            this.algorithmLineNumbers = []; // Store line numbers for linking
            this.algorithmFilePaths = []; // Store file paths for each line
            this.algorithmFilePath = agentFilePath; // Store default file path for highlighting
            
            for (let i = algoStartLine; i <= algoEndLine && i < lines.length; i++) {
                let line = lines[i];
                
                // Remove carriage returns and trim whitespace
                line = line.replace(/\r/g, '').trimEnd();
                
                if (line.startsWith('    ')) {
                    line = line.substring(4); // Remove 4-space indent
                }

                // Find the matching phase line number and file
                let matchedLineNumber = i + 1; // Default to algorithm line itself
                let matchedFilePath = agentFilePath; // Default to agent file
                
                for (const [phase, mapping] of Object.entries(phaseLineMapping)) {
                    if (line.includes(phase)) {
                        matchedLineNumber = mapping.line;
                        matchedFilePath = mapping.file;
                        break;
                    }
                }

                // Store the line text, its actual implementation line number, and file path
                this.rawAlgorithmLines.push(line);
                this.algorithmLineNumbers.push(matchedLineNumber);
                this.algorithmFilePaths.push(matchedFilePath);
            }

            // Set algorithm panel to show raw algorithm with clickable file references
            this.algorithmPanelLines = this.rawAlgorithmLines.map((line, idx) => {
                return this.formatFileReference(line, this.algorithmFilePaths[idx], this.algorithmLineNumbers[idx], false);
            });
            
        } catch (error) {
            this.algorithmPanelLines = [`Error loading algorithm: ${error.message}`];
        }
    }

    // Highlight a specific phase in the algorithm (called by breakpoint)
    highlightAlgorithmPhase(phaseName) {
        if (!this.rawAlgorithmLines || !this.algorithmFilePath) {
            return; // Algorithm not loaded yet
        }

        // ANSI codes for inverted text (reverse video)
        const invert = '\x1b[7m';
        const reset = '\x1b[0m';

        // Find which line contains the phase name
        let highlightIndex = -1;
        for (let i = 0; i < this.rawAlgorithmLines.length; i++) {
            if (this.rawAlgorithmLines[i].includes(phaseName)) {
                highlightIndex = i;
                break;
            }
        }

        // Rebuild algorithm panel with highlighting and clickable links
        this.algorithmPanelLines = [];
        for (let i = 0; i < this.rawAlgorithmLines.length; i++) {
            let line = this.rawAlgorithmLines[i];
            // Ensure no carriage returns in the line
            line = line.replace(/\r/g, '');
            
            const linkedLine = this.formatFileReference(line, this.algorithmFilePaths[i], this.algorithmLineNumbers[i], false);
            
            if (i === highlightIndex) {
                // Apply highlighting around the entire linked line
                this.algorithmPanelLines.push(`${invert}${linkedLine}${reset}`);
            } else {
                this.algorithmPanelLines.push(linkedLine);
            }
        }
    }

    // Cache padding strings for better performance with wide terminals
    getPadding(length) {
        if (length <= 0) return '';
        if (length > 500) length = 500; // Cap excessive padding
        
        if (!this.paddingCache) this.paddingCache = new Map();
        
        if (!this.paddingCache.has(length)) {
            this.paddingCache.set(length, ' '.repeat(length));
        }
        return this.paddingCache.get(length);
    }

    // Close the UI
    close() {
        this.cleanup();
        if (this.rl) {
            this.rl.close();
        }
    }
}

module.exports = { TerminalUI, BG_COLORS };
