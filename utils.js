// Utility functions for the AI Agent system

/**
 * Estimate token count for text
 * Rough approximation: ~4 characters per token
 * @param {string} text - The text to estimate tokens for
 * @returns {number} Estimated number of tokens
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Calculate the visual width of text in terminal
 * Accounts for emojis and wide characters that take up 2 terminal cells
 * Also strips ANSI escape codes before measuring
 * @param {string} str - The text to measure
 * @returns {number} Visual width in terminal cells
 */
function getVisualWidth(str) {
    if (!str) return 0;

    // Remove ANSI escape codes
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    const cleanStr = str.replace(ansiRegex, '');
    let width = 0;

    for (const char of cleanStr) {
        const code = char.codePointAt(0);

        // Check for emoji ranges and wide characters
        // Most emojis are in these ranges and take up 2 cells
        if (
            (code >= 0x1F300 && code <= 0x1F9FF) || // Emoticons, symbols, pictographs
            (code >= 0x1F600 && code <= 0x1F64F) || // Emoticons
            (code >= 0x1F680 && code <= 0x1F6FF) || // Transport and map symbols
            (code >= 0x2600 && code <= 0x26FF) ||   // Miscellaneous symbols
            (code >= 0x2700 && code <= 0x27BF) ||   // Dingbats
            (code >= 0xFE00 && code <= 0xFE0F) ||   // Variation selectors
            (code >= 0x1F900 && code <= 0x1F9FF) || // Supplemental Symbols and Pictographs
            (code >= 0x1F1E6 && code <= 0x1F1FF)    // Regional indicator symbols (flags)
        ) {
            width += 2; // Emojis take 2 cells
        } else if (code >= 0x10000) {
            width += 2; // Other supplementary characters
        } else {
            width += 1; // Normal ASCII and basic characters
        }
    }

    return width;
}

/**
 * Pad text to a specific visual width
 * Uses getVisualWidth to correctly handle emojis and ANSI codes
 * @param {string} text - The text to pad
 * @param {number} width - Target visual width
 * @returns {string} Padded text
 */
function padToVisualWidth(text, width) {
    const visualLength = getVisualWidth(text);
    const padding = Math.max(0, width - visualLength);
    return text + ' '.repeat(padding);
}

/**
 * Wrap text to fit within a specific width
 * Preserves ANSI escape codes and handles emojis correctly
 * @param {string} text - The text to wrap
 * @param {number} width - Maximum visual width per line
 * @returns {string[]} Array of wrapped lines
 */
function wrapText(text, width) {
    if (!text) return [''];
    if (width <= 0) return [text];

    const lines = [];
    const ansiRegex = /\x1b\[[0-9;]*m/g;

    // Split by newlines first to preserve explicit line breaks
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
        if (getVisualWidth(paragraph) <= width) {
            lines.push(paragraph);
            continue;
        }

        // Extract ANSI codes and their positions
        let cleanText = '';
        let ansiCodes = [];
        let lastIndex = 0;
        let match;

        const regex = new RegExp(ansiRegex);
        while ((match = regex.exec(paragraph)) !== null) {
            cleanText += paragraph.slice(lastIndex, match.index);
            ansiCodes.push({ pos: cleanText.length, code: match[0] });
            lastIndex = match.index + match[0].length;
        }
        cleanText += paragraph.slice(lastIndex);

        // Wrap the clean text
        let currentLine = '';
        let currentWidth = 0;
        let charIndex = 0;

        // Track active ANSI codes to carry them across lines
        let activeAnsi = '';

        for (const char of cleanText) {
            // Check for ANSI codes at this position
            const codesAtPos = ansiCodes.filter(a => a.pos === charIndex);
            for (const { code } of codesAtPos) {
                currentLine += code;
                // Track active formatting
                if (code.includes('[0m')) {
                    activeAnsi = ''; // Reset
                } else {
                    activeAnsi += code;
                }
            }

            const charWidth = getVisualWidth(char);

            // If adding this char would exceed width, start new line
            if (currentWidth + charWidth > width && currentLine) {
                // Reset formatting at end of line if needed
                if (activeAnsi) {
                    currentLine += '\x1b[0m';
                }
                lines.push(currentLine);
                currentLine = activeAnsi; // Carry formatting to next line
                currentWidth = 0;
            }

            currentLine += char;
            currentWidth += charWidth;
            charIndex++;
        }

        // Add any remaining text
        if (currentLine) {
            if (activeAnsi) {
                currentLine += '\x1b[0m';
            }
            lines.push(currentLine);
        }
    }

    return lines.length > 0 ? lines : [''];
}

module.exports = {
    estimateTokens,
    getVisualWidth,
    padToVisualWidth,
    wrapText
};
