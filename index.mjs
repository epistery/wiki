import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { Config } from 'epistery';
import StorageFactory from './storage/StorageFactory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Wiki Agent
 *
 * Decentralized wiki with IPFS storage and epistery authentication.
 * Adapted from wiki-mixin to work with epistery data wallets.
 */
export default class WikiAgent {
  constructor(config = {}) {
    this.config = config;
    this.epistery = null;
    this.rootDoc = config.rootDoc || 'Home';
    // Per-domain state (keyed by domain)
    this.domainStates = new Map();
  }

  /**
   * Get or initialize domain state (storage and index)
   */
  async getDomainState(domain) {
    if (!this.domainStates.has(domain)) {
      const storage = await StorageFactory.create(null, domain);
      const index = new Map();

      // Load index from storage
      try {
        const indexData = JSON.parse((await storage.readFile('index.json')).toString());
        if (indexData && indexData.documents) {
          Object.entries(indexData.documents).forEach(([k, v]) => index.set(k, v));
          console.log(`[wiki] Loaded index with ${index.size} documents for ${domain}`);
        }
      } catch (error) {
        console.log(`[wiki] No existing index for ${domain}, starting fresh`);
      }

      this.domainStates.set(domain, { storage, index });
    }
    return this.domainStates.get(domain);
  }

  /**
   * Attach the agent to an Express router
   * Called by AgentManager after instantiation
   *
   * @param {express.Router} router - Express router instance
   */
  attach(router) {
    // Domain and epistery middleware
    router.use(async (req, res, next) => {
      req.domain = req.hostname || 'localhost';
      req.wikiState = await this.getDomainState(req.domain);
      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;
      }
      next();
    });

    // Authentication middleware
    router.use(async (req, res, next) => {
      try {
        const auth = await this.getAuthenticatedRivet(req);
        req.wikiAuth = auth.valid ? auth : null;
        next();
      } catch (error) {
        console.error('[wiki] Auth middleware error:', error);
        req.wikiAuth = null;
        next();
      }
    });

    // Serve icon
    router.get('/icon.svg', (req, res) => {
      const iconPath = path.join(__dirname, 'icon.svg');
      if (!existsSync(iconPath)) {
        // Return a default wiki icon
        res.set('Content-Type', 'image/svg+xml');
        res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          <line x1="8" y1="6" x2="16" y2="6"/>
          <line x1="8" y1="10" x2="16" y2="10"/>
          <line x1="8" y1="14" x2="12" y2="14"/>
        </svg>`);
        return;
      }
      res.set('Content-Type', 'image/svg+xml');
      res.sendFile(iconPath);
    });

    // Serve widget (for agent box)
    router.get('/widget', (req, res) => {
      const widgetPath = path.join(__dirname, 'client/widget.html');
      if (!existsSync(widgetPath)) {
        return res.status(404).send('Widget not found');
      }
      res.sendFile(widgetPath);
    });

    // Serve admin page
    router.get('/admin', (req, res) => {
      const adminPath = path.join(__dirname, 'client/admin.html');
      if (!existsSync(adminPath)) {
        return res.status(404).send('Admin page not found');
      }
      res.sendFile(adminPath);
    });

    // Serve client.js for publishers
    router.get('/client.js', (req, res) => {
      const clientPath = path.join(__dirname, 'client/client.js');
      if (!existsSync(clientPath)) {
        return res.status(404).send('Client script not found');
      }
      res.set('Content-Type', 'text/javascript');
      res.sendFile(clientPath);
    });

    // Serve MarkUp.mjs renderer
    router.get('/MarkUp.mjs', (req, res) => {
      const markupPath = path.join(__dirname, 'client/MarkUp.mjs');
      if (!existsSync(markupPath)) {
        return res.status(404).send('MarkUp module not found');
      }
      res.set('Content-Type', 'text/javascript');
      res.sendFile(markupPath);
    });

    // Wiki index endpoint - list all documents
    router.get('/index', async (req, res) => {
      try {
        const index = await this.getIndex(req.wikiAuth, req.wikiState);
        res.json(index);
      } catch (error) {
        console.error('[wiki] Index error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Status endpoint
    router.get('/status', async (req, res) => {
      try {
        const docCount = req.wikiState.index.size;
        res.json({
          agent: 'wiki',
          version: '0.1.0',
          documentCount: docCount,
          rootDoc: this.rootDoc,
          storage: req.wikiState.storage.constructor.name,
          config: this.config
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Wiki document CRUD handler
    const handleDocument = async (req, res) => {
      try {
        const method = req.method.toLowerCase();
        const docId = req.params.docId || this.rootDoc;

        // GET - read document (no auth required for public docs)
        if (method === 'get') {
          // Check Accept header - serve HTML for browsers, JSON for API
          const acceptsHtml = req.accepts(['html', 'json']) === 'html';

          if (acceptsHtml) {
            // Serve the wiki page viewer
            const pagePath = path.join(__dirname, 'client/page.html');
            if (existsSync(pagePath)) {
              return res.sendFile(pagePath);
            }
          }

          // Read _pid from cookie for new documents (like wiki-mixin does)
          const pidFromCookie = req.cookies?._pid || '';
          const options = { _pid: pidFromCookie, ...req.query };

          // JSON response for API clients
          const doc = await this.get(req.wikiAuth, docId, options, req.wikiState);

          // Set cookie for next navigation (like wiki-mixin does)
          const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
          res.cookie('_pid', docId, { expires, sameSite: 'Strict' });

          if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
          }
          res.json(doc);
          return;
        }

        // POST or PUT - create/update document (auth required)
        // Both methods accepted so "post to the wiki" works naturally
        if (method === 'post' || method === 'put') {
          if (!req.wikiAuth) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const canWrite = await this.canWrite(req.wikiAuth, req);
          if (!canWrite) {
            return res.status(403).json({ error: 'Write permission denied' });
          }

          const result = await this.put(req.wikiAuth, docId, req.query, req.body, req.wikiState);
          res.json(result);
          return;
        }

        // DELETE - remove document (auth required)
        if (method === 'delete') {
          if (!req.wikiAuth) {
            return res.status(401).json({ error: 'Authentication required' });
          }

          const canWrite = await this.canWrite(req.wikiAuth, req);
          if (!canWrite) {
            return res.status(403).json({ error: 'Write permission denied' });
          }

          const result = await this.delete(req.wikiAuth, docId, req.wikiState);
          res.json(result);
          return;
        }

        res.status(405).json({ error: 'Method not allowed' });
      } catch (error) {
        console.error(`[wiki] Error on ${req.method} /${req.params.docId}:`, error);
        res.status(500).json({ error: error.message });
      }
    };

    // Mount document handler on both root and /:docId
    router.all('/', handleDocument);
    router.all('/:docId', handleDocument);
  }

  /**
   * Get authenticated rivet from request
   * Epistery 1.3.0+ handles all authentication (session, bot, key exchange)
   * and sets req.episteryClient
   */
  async getAuthenticatedRivet(req) {
    // Epistery middleware already handles:
    // - Session cookies (_epistery)
    // - Bot authentication (Authorization: Bot header)
    // - Key exchange (sets req.episteryClient)
    if (req.episteryClient && req.episteryClient.address) {
      return {
        valid: true,
        rivetAddress: req.episteryClient.address,
        publicKey: req.episteryClient.publicKey,
        authenticated: req.episteryClient.authenticated || true,
        authType: 'epistery'
      };
    }

    // No authentication found - allow anonymous read
    return { valid: false, error: 'Not authenticated', anonymous: true };
  }

  /**
   * Check if user can write to wiki
   * Access: epistery::admin or epistery::editor
   * Epistery plugin handles sponsor fallback when no admins exist
   */
  async canWrite(auth, req) {
    console.log('[wiki] canWrite check:', {
      hasAuth: !!auth,
      valid: auth?.valid,
      address: auth?.rivetAddress,
      authType: auth?.authType
    });

    if (!auth || !auth.valid) {
      console.log('[wiki] Write denied: not authenticated');
      return false;
    }

    // Development mode: allow localhost
    if (this.config.devMode) {
      console.log('[wiki] Write allowed: devMode');
      return true;
    }

    // Localhost auto-allow for development
    if (req && (req.hostname === 'localhost' || req.hostname === '127.0.0.1')) {
      console.log('[wiki] Write allowed: localhost');
      return true;
    }

    // Check standard epistery access lists
    // Note: epistery.isListed() handles sponsor fallback internally
    if (this.epistery) {
      try {
        const isAdmin = await this.epistery.isListed(auth.rivetAddress, 'epistery::admin');
        if (isAdmin) {
          console.log('[wiki] Write allowed: epistery::admin');
          return true;
        }

        const isEditor = await this.epistery.isListed(auth.rivetAddress, 'epistery::editor');
        if (isEditor) {
          console.log('[wiki] Write allowed: epistery::editor');
          return true;
        }
      } catch (error) {
        console.error('[wiki] Permission check error:', error);
      }
    }

    console.log('[wiki] Write denied: not on epistery::admin or epistery::editor');
    return false;
  }

  /**
   * Save the document index to storage
   */
  async saveIndex(wikiState) {
    try {
      const indexData = {
        documents: Object.fromEntries(wikiState.index),
        updated: new Date().toISOString()
      };
      await wikiState.storage.writeFile('index.json', JSON.stringify(indexData, null, 2));
    } catch (error) {
      console.error('[wiki] Failed to save index:', error);
    }
  }

  /**
   * Get document index
   */
  async getIndex(auth, wikiState) {
    const results = [];
    for (const [docId, meta] of wikiState.index) {
      // Filter by visibility
      if (meta.visibility === 'public' ||
          (auth && auth.rivetAddress === meta.owner)) {
        results.push({
          _id: docId,
          title: meta.title,
          _pid: meta._pid,
          listed: meta.listed !== false,
          rootmenu: meta.rootmenu || false,
          visibility: meta.visibility,
          _modified: meta._modified
        });
      }
    }
    return results.sort((a, b) => a._id.localeCompare(b._id));
  }

  /**
   * Get a document by ID
   */
  async get(auth, docId, options = {}, wikiState) {
    if (!docId) docId = this.rootDoc;

    // Check index for document metadata
    const meta = wikiState.index.get(docId);

    if (!meta) {
      // Document doesn't exist - return template with _pid from cookie (like wiki-mixin)
      return {
        _id: docId,
        title: docId,
        body: `# ${docId}\n`,
        _pid: options._pid || '',
        visibility: 'public',
        _new: true
      };
    }

    // Check visibility
    if (meta.visibility !== 'public') {
      if (!auth || !auth.valid) {
        return null; // Not authorized to view private doc
      }
      if (auth.rivetAddress !== meta.owner) {
        // Check if user has access via list
        // For now, only owner can see private docs
        return null;
      }
    }

    // Load document content from storage
    try {
      const content = await this.loadDocument(docId, wikiState);
      return {
        _id: docId,
        ...meta,
        ...content
      };
    } catch (error) {
      console.error(`[wiki] Failed to load document ${docId}:`, error);
      return null;
    }
  }

  /**
   * Create or update a document
   * Wikis are collaborative - anyone with write access can edit any document
   */
  async put(auth, docId, options = {}, body = {}, wikiState) {
    if (!docId) throw new Error('Document ID is required');
    if (!auth || !auth.valid) throw new Error('Authentication required');

    const now = new Date().toISOString();
    const existingMeta = wikiState.index.get(docId);

    // Prepare document
    const doc = {
      _id: docId,
      title: body.title || docId,
      body: body.body || '',
      _pid: body._pid || options._pid || '',
      visibility: body.visibility || 'public',
      listed: body.listed !== false,
      rootmenu: body.rootmenu || false,
      owner: existingMeta?.owner || auth.rivetAddress, // Track original creator
      _createdBy: existingMeta?._createdBy || auth.rivetAddress,
      _created: existingMeta?._created || now,
      _modified: now,
      _modifiedBy: auth.rivetAddress // Track who made this edit
    };

    // No ownership check - wikis are collaborative
    // Anyone with write access (epistery::admin or epistery::editor) can edit any document

    // Save document content to storage
    await this.saveDocument(docId, doc, wikiState);

    // Update index
    const meta = {
      title: doc.title,
      _pid: doc._pid,
      visibility: doc.visibility,
      listed: doc.listed,
      rootmenu: doc.rootmenu,
      owner: doc.owner,
      _createdBy: doc._createdBy,
      _created: doc._created,
      _modified: doc._modified,
      _modifiedBy: doc._modifiedBy
    };
    wikiState.index.set(docId, meta);
    await this.saveIndex(wikiState);

    console.log(`[wiki] Document saved: ${docId} (edited by ${auth.rivetAddress})`);
    return doc;
  }

  /**
   * Delete a document
   * Only epistery::admin can delete documents (more restrictive than edit)
   */
  async delete(auth, docId, wikiState) {
    if (!docId) throw new Error('Document ID is required');
    if (!auth || !auth.valid) throw new Error('Authentication required');

    const meta = wikiState.index.get(docId);
    if (!meta) {
      throw new Error('Document not found');
    }

    // Only admins can delete documents
    // Note: epistery.isListed() handles sponsor fallback internally
    const isAdmin = await this.epistery?.isListed(auth.rivetAddress, 'epistery::admin');
    if (!isAdmin) {
      throw new Error('Only epistery::admin can delete documents');
    }

    // Remove from index
    wikiState.index.delete(docId);
    await this.saveIndex(wikiState);

    console.log(`[wiki] Document deleted: ${docId} (by ${auth.rivetAddress})`);
    return { success: true, docId };
  }

  /**
   * Load document content from storage
   */
  async loadDocument(docId, wikiState) {
    try {
      const filename = `doc_${this.sanitizeFilename(docId)}.json`;
      const content = JSON.parse((await wikiState.storage.readFile(filename)).toString());
      return content;
    } catch (error) {
      throw new Error('Document not found');
    }
  }

  /**
   * Save document content to storage
   */
  async saveDocument(docId, doc, wikiState) {
    const content = {
      title: doc.title,
      body: doc.body,
      _pid: doc._pid
    };

    const filename = `doc_${this.sanitizeFilename(docId)}.json`;
    await wikiState.storage.writeFile(filename, JSON.stringify(content, null, 2));
    return docId;
  }

  /**
   * Sanitize filename to prevent directory traversal
   */
  sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Cleanup on shutdown
   */
  async cleanup() {
    // Save all domain states
    for (const [domain, state] of this.domainStates) {
      await this.saveIndex(state);
    }
  }
}
