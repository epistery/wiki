/**
 * MarkUp - Wiki markdown renderer with extensions
 *
 * Adapted from wiki-mixin for epistery wiki agent.
 * Uses marked for markdown and Mermaid for diagrams.
 */

// WikiWord processor - converts CamelCase words to wiki links
class WikiWord {
  constructor(basePath = '/wiki') {
    this.basePath = basePath;
  }

  process(body, parentId = '') {
    // Match CamelCase words that aren't already in links
    // Must have at least two capital letters and be at least 3 chars
    const wikiWordRegex = /(?<![[\w])([A-Z][a-z]+(?:[A-Z][a-z]+)+)(?![\]\w])/g;

    return body.replace(wikiWordRegex, (match, word) => {
      // Don't convert words that are part of code blocks
      if (this.isInCodeBlock(body, body.indexOf(match))) {
        return match;
      }
      return `[${word}](${this.basePath}/${word})`;
    });
  }

  isInCodeBlock(text, position) {
    // Simple check - count backticks before position
    const before = text.substring(0, position);
    const singleTicks = (before.match(/`/g) || []).length;
    const tripleTicks = (before.match(/```/g) || []).length;

    // If odd number of single ticks (not triple), we're in inline code
    // If odd number of triple ticks, we're in a code block
    return (singleTicks - tripleTicks * 3) % 2 === 1 || tripleTicks % 2 === 1;
  }
}

export default class MarkUp {
  constructor(options = {}) {
    this.wikiWord = new WikiWord(options.basePath || '/wiki');
    this.marked = null;
    this.mermaidInitialized = false;
  }

  /**
   * Initialize the renderer
   * Must be called before render()
   */
  async init() {
    // Dynamic import marked
    if (!this.marked) {
      const { marked } = await import('https://cdn.jsdelivr.net/npm/marked@12.0.0/lib/marked.esm.js');
      this.marked = marked;

      // Configure marked
      this.marked.setOptions({
        gfm: true,
        breaks: true
      });
    }

    // Initialize Mermaid
    if (!this.mermaidInitialized && typeof window !== 'undefined') {
      await this.initMermaid();
    }
  }

  /**
   * Initialize Mermaid diagram renderer
   */
  async initMermaid() {
    if (typeof window === 'undefined') return;

    // Check if mermaid is already loaded
    if (window.mermaid) {
      this.mermaidInitialized = true;
      return;
    }

    // Load mermaid from CDN
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
      script.onload = () => {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose'
        });
        this.mermaidInitialized = true;
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /**
   * Render markdown to HTML
   * @param {string} body - Markdown content
   * @param {object} options - Render options
   * @returns {Promise<string>} HTML content
   */
  async render(body, options = {}) {
    await this.init();

    // Process extension blocks (mermaid, frame, etc.)
    body = await this.replaceExtensionBlocks(body, options);

    // Process WikiWords
    const wordified = this.wikiWord.process(body, options._pid);

    // Render markdown
    let result = await this.marked.parse(wordified);

    // Add default styles
    result += `
<style>
.doclet-render h1 { margin-top: 0; }
.mermaid-container { margin: 1em 0; overflow-x: auto; }
.frame-set { display: flex; flex-wrap: wrap; gap: 1em; }
.frame-container { flex: 1; min-width: 300px; }
.frame-container.titled { border: 1px solid #ccc; border-radius: 4px; }
.frame-title { background: #f5f5f5; padding: 0.5em 1em; font-weight: bold; }
.frame-container iframe { width: 100%; height: 400px; border: none; }
</style>`;

    return result;
  }

  /**
   * Process extension blocks: mermaid, frame
   */
  async replaceExtensionBlocks(body, options) {
    const asyncBlocks = [];
    let blockId = 0;

    // Replace fenced code blocks with extensions
    // Support both ~~~ and ``` delimiters
    const blockRegex = /^(`{3,4}|~{3,4})(mermaid|frame)(?:\((.*?)\))?\n([\s\S]*?)\n\1/gm;

    body = body.replace(blockRegex, (match, delimiter, lang, args, content) => {
      const blockArgs = args ? args.split(',').map(a => a.trim()) : [];

      if (lang === 'mermaid') {
        // Generate placeholder for async mermaid rendering
        const id = `mermaid-${++blockId}`;
        asyncBlocks.push({ id, lang, content });
        return `<div class="mermaid-container" id="${id}">${this.escapeHtml(content)}</div>`;
      }

      if (lang === 'frame') {
        // Parse frame definitions
        const frames = content.split('\n').filter(line => line.trim()).map(line => {
          const frameMatch = line.match(/^(.*?)(?:\[(.*?)\])?(\/.*?)$/);
          if (frameMatch) {
            const [, title, style, path] = frameMatch;
            return `<div class="frame-container ${title ? 'titled' : ''}" ${style ? `style="${style}"` : ''}>
              ${title ? `<div class="frame-title">${title}</div>` : ''}
              <iframe src="${path.replace(/"/g, '%22')}"></iframe>
            </div>`;
          }
          return '';
        }).join('\n');

        return `<div class="frame-set">\n${frames}\n</div>`;
      }

      return match;
    });

    return body;
  }

  /**
   * Post-process rendered HTML to initialize Mermaid diagrams
   * Call this after inserting rendered HTML into the DOM
   */
  async renderMermaidDiagrams(container) {
    if (typeof window === 'undefined' || !window.mermaid) return;

    const mermaidElements = container.querySelectorAll('.mermaid-container');
    for (const el of mermaidElements) {
      try {
        const id = el.id;
        const content = el.textContent;
        const { svg } = await window.mermaid.render(id + '-svg', content);
        el.innerHTML = svg;
      } catch (error) {
        console.error('[MarkUp] Mermaid render error:', error);
        el.innerHTML = `<pre class="mermaid-error">Diagram error: ${error.message}</pre>`;
      }
    }
  }

  /**
   * Escape HTML entities
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export for use as ES module or in browser
if (typeof window !== 'undefined') {
  window.MarkUp = MarkUp;
}
