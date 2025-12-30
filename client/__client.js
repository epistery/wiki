/**
 * Epistery Wiki Client
 *
 * Client-side library for the epistery wiki agent.
 * Handles document loading, editing, and rendering.
 */
(function() {
  'use strict';

  class WikiClient {
    constructor(options = {}) {
      this.baseUrl = options.baseUrl || '/agent/epistery/wiki';
      this.witness = null;
      this.markup = null;
      this.currentDoc = null;
      this.editMode = false;
    }

    /**
     * Initialize the wiki client
     */
    async init() {
      // Load MarkUp renderer
      const MarkUp = await import(this.baseUrl + '/client/MarkUp.mjs').then(m => m.default);
      this.markup = new MarkUp({ basePath: this.baseUrl });
      await this.markup.init();

      // Connect to epistery witness if available
      if (window.Witness) {
        this.witness = await window.Witness.connect();
      }

      // Dispatch ready event
      window.dispatchEvent(new CustomEvent('wiki:ready', { detail: { client: this } }));
    }

    /**
     * Get authenticated headers
     */
    async getAuthHeaders() {
      const headers = {
        'Content-Type': 'application/json'
      };

      // Add epistery auth if available
      if (this.witness && this.witness.createAuthHeader) {
        headers['Authorization'] = await this.witness.createAuthHeader();
      }

      return headers;
    }

    /**
     * Load document index
     */
    async getIndex() {
      const response = await fetch(this.baseUrl + '/index', {
        headers: await this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Failed to load index: ${response.status}`);
      }

      return response.json();
    }

    /**
     * Load a document
     */
    async get(docId) {
      const response = await fetch(this.baseUrl + '/' + encodeURIComponent(docId), {
        headers: await this.getAuthHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to load document: ${response.status}`);
      }

      this.currentDoc = await response.json();
      return this.currentDoc;
    }

    /**
     * Save a document
     */
    async put(docId, doc) {
      const response = await fetch(this.baseUrl + '/' + encodeURIComponent(docId), {
        method: 'PUT',
        headers: await this.getAuthHeaders(),
        body: JSON.stringify(doc)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(error.error || `Failed to save document: ${response.status}`);
      }

      this.currentDoc = await response.json();
      return this.currentDoc;
    }

    /**
     * Delete a document
     */
    async delete(docId) {
      const response = await fetch(this.baseUrl + '/' + encodeURIComponent(docId), {
        method: 'DELETE',
        headers: await this.getAuthHeaders()
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Delete failed' }));
        throw new Error(error.error || `Failed to delete document: ${response.status}`);
      }

      return response.json();
    }

    /**
     * Render markdown content
     */
    async render(body, options = {}) {
      if (!this.markup) {
        throw new Error('MarkUp renderer not initialized');
      }
      return this.markup.render(body, options);
    }

    /**
     * Post-process rendered content (initialize Mermaid diagrams)
     */
    async postProcess(container) {
      if (this.markup) {
        await this.markup.renderMermaidDiagrams(container);
      }
    }

    /**
     * Load and render a document into a container
     */
    async loadAndRender(docId, container) {
      const doc = await this.get(docId);
      if (!doc) {
        container.innerHTML = '<p>Document not found</p>';
        return null;
      }

      const html = await this.render(doc.body, { _pid: doc._pid });
      container.innerHTML = html;
      await this.postProcess(container);

      // Dispatch event
      window.dispatchEvent(new CustomEvent('wiki:loaded', { detail: { doc, container } }));

      return doc;
    }

    /**
     * Create a wiki editor
     */
    createEditor(container, options = {}) {
      return new WikiEditor(this, container, options);
    }

    /**
     * Get wiki status
     */
    async getStatus() {
      const response = await fetch(this.baseUrl + '/status');
      return response.json();
    }
  }

  /**
   * Wiki Editor Component
   */
  class WikiEditor {
    constructor(client, container, options = {}) {
      this.client = client;
      this.container = container;
      this.options = options;
      this.doc = null;
      this.modified = false;

      this.setupEditor();
    }

    setupEditor() {
      this.container.innerHTML = `
        <div class="wiki-editor">
          <div class="wiki-editor-toolbar">
            <input type="text" class="wiki-editor-title" placeholder="Document Title">
            <select class="wiki-editor-visibility">
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
            <button class="wiki-editor-save">Save</button>
            <button class="wiki-editor-preview">Preview</button>
            <button class="wiki-editor-cancel">Cancel</button>
          </div>
          <textarea class="wiki-editor-body" placeholder="Enter markdown content..."></textarea>
          <div class="wiki-editor-preview-pane" style="display: none;"></div>
        </div>
        <style>
          .wiki-editor { display: flex; flex-direction: column; height: 100%; }
          .wiki-editor-toolbar { display: flex; gap: 0.5em; padding: 0.5em; background: #f5f5f5; }
          .wiki-editor-title { flex: 1; padding: 0.5em; }
          .wiki-editor-body { flex: 1; padding: 1em; font-family: monospace; resize: none; min-height: 400px; }
          .wiki-editor-preview-pane { flex: 1; padding: 1em; overflow: auto; }
        </style>
      `;

      // Get elements
      this.titleInput = this.container.querySelector('.wiki-editor-title');
      this.bodyInput = this.container.querySelector('.wiki-editor-body');
      this.visibilitySelect = this.container.querySelector('.wiki-editor-visibility');
      this.previewPane = this.container.querySelector('.wiki-editor-preview-pane');
      this.saveButton = this.container.querySelector('.wiki-editor-save');
      this.previewButton = this.container.querySelector('.wiki-editor-preview');
      this.cancelButton = this.container.querySelector('.wiki-editor-cancel');

      // Bind events
      this.saveButton.addEventListener('click', () => this.save());
      this.previewButton.addEventListener('click', () => this.togglePreview());
      this.cancelButton.addEventListener('click', () => this.cancel());
      this.bodyInput.addEventListener('input', () => this.modified = true);
      this.titleInput.addEventListener('input', () => this.modified = true);
    }

    /**
     * Load a document into the editor
     */
    async load(docId) {
      this.doc = await this.client.get(docId);
      if (this.doc) {
        this.titleInput.value = this.doc.title || docId;
        this.bodyInput.value = this.doc.body || '';
        this.visibilitySelect.value = this.doc.visibility || 'public';
      } else {
        this.doc = { _id: docId, title: docId, body: `# ${docId}\n`, visibility: 'public' };
        this.titleInput.value = docId;
        this.bodyInput.value = this.doc.body;
      }
      this.modified = false;
    }

    /**
     * Save the document
     */
    async save() {
      if (!this.doc) return;

      const updatedDoc = {
        title: this.titleInput.value,
        body: this.bodyInput.value,
        visibility: this.visibilitySelect.value,
        _pid: this.doc._pid || ''
      };

      try {
        this.doc = await this.client.put(this.doc._id, updatedDoc);
        this.modified = false;

        window.dispatchEvent(new CustomEvent('wiki:saved', { detail: { doc: this.doc } }));
      } catch (error) {
        console.error('[WikiEditor] Save error:', error);
        alert('Failed to save: ' + error.message);
      }
    }

    /**
     * Toggle preview mode
     */
    async togglePreview() {
      const showPreview = this.previewPane.style.display === 'none';

      if (showPreview) {
        const html = await this.client.render(this.bodyInput.value);
        this.previewPane.innerHTML = html;
        await this.client.postProcess(this.previewPane);
        this.bodyInput.style.display = 'none';
        this.previewPane.style.display = 'block';
        this.previewButton.textContent = 'Edit';
      } else {
        this.bodyInput.style.display = 'block';
        this.previewPane.style.display = 'none';
        this.previewButton.textContent = 'Preview';
      }
    }

    /**
     * Cancel editing
     */
    cancel() {
      if (this.modified) {
        if (!confirm('You have unsaved changes. Discard?')) {
          return;
        }
      }

      window.dispatchEvent(new CustomEvent('wiki:cancelled', { detail: { doc: this.doc } }));
    }

    /**
     * Get current content
     */
    getContent() {
      return {
        title: this.titleInput.value,
        body: this.bodyInput.value,
        visibility: this.visibilitySelect.value
      };
    }
  }

  // Auto-initialize if data attribute is present
  document.addEventListener('DOMContentLoaded', async () => {
    const autoInit = document.querySelector('[data-wiki-auto-init]');
    if (autoInit) {
      const client = new WikiClient();
      await client.init();
      window.wikiClient = client;

      // If there's a document to load
      const docId = autoInit.dataset.wikiDocId;
      if (docId) {
        await client.loadAndRender(docId, autoInit);
      }
    }
  });

  // Export
  window.WikiClient = WikiClient;
  window.WikiEditor = WikiEditor;

})();
