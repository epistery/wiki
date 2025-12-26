import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { Config } from 'epistery';

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
    // In-memory index for document metadata (will be persisted via Config)
    this.index = new Map();

    // Initialize storage immediately using epistery Config
    this.storageConfig = new Config();
    this.storageConfig.setPath('/wiki');
    // TODO: Replace with Config.createFolder() when available

    // Load existing index
    this.loadIndex().catch(err => {
      console.log('[wiki] No existing index, starting fresh');
    });
  }

  /**
   * Attach the agent to an Express router
   * Called by AgentManager after instantiation
   *
   * @param {express.Router} router - Express router instance
   */
  attach(router) {
    // Store epistery instance from app.locals if available
    router.use((req, res, next) => {
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
        const index = await this.getIndex(req.wikiAuth);
        res.json(index);
      } catch (error) {
        console.error('[wiki] Index error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Status endpoint
    router.get('/status', async (req, res) => {
      try {
        const docCount = this.index.size;
        res.json({
          agent: 'wiki',
          version: '0.1.0',
          documentCount: docCount,
          rootDoc: this.rootDoc,
          storage: 'ipfs',
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
          const doc = await this.get(req.wikiAuth, docId, options);

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

          const result = await this.put(req.wikiAuth, docId, req.query, req.body);
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

          const result = await this.delete(req.wikiAuth, docId);
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
   * Supports bot authentication and epistery session
   */
  async getAuthenticatedRivet(req) {
    // 1. Check epistery core session
    if (req.episteryClient && req.episteryClient.address) {
      return {
        valid: true,
        rivetAddress: req.episteryClient.address,
        publicKey: req.episteryClient.publicKey,
        authenticated: req.episteryClient.authenticated,
        authType: 'epistery'
      };
    }

    // 2. Check for Bot authentication
    if (req.headers.authorization?.startsWith('Bot ')) {
      try {
        const authHeader = req.headers.authorization.substring(4);
        const decoded = Buffer.from(authHeader, 'base64').toString('utf8');
        const payload = JSON.parse(decoded);

        const { address, signature, message } = payload;

        if (!address || !signature || !message) {
          return { valid: false, error: 'Bot auth: Missing required fields' };
        }

        // Verify the signature using ethers
        const { ethers } = await import('ethers');
        const recoveredAddress = ethers.utils.verifyMessage(message, signature);

        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
          return { valid: false, error: 'Bot auth: Invalid signature' };
        }

        return {
          valid: true,
          rivetAddress: address,
          authType: 'bot'
        };
      } catch (error) {
        console.error('[wiki] Bot auth error:', error);
        return { valid: false, error: `Bot auth failed: ${error.message}` };
      }
    }

    // No authentication found - allow anonymous read
    return { valid: false, error: 'Not authenticated', anonymous: true };
  }

  /**
   * Check if user can write to wiki
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

    // Check wiki write list or admin list
    if (this.epistery) {
      try {
        const isWriter = await this.epistery.isListed(auth.rivetAddress, 'wiki::writers');
        if (isWriter) {
          console.log('[wiki] Write allowed: wiki::writers');
          return true;
        }

        const isAdmin = await this.epistery.isListed(auth.rivetAddress, 'epistery::admin');
        if (isAdmin) {
          console.log('[wiki] Write allowed: epistery::admin');
          return true;
        }

        // Fallback: check sponsor
        const sponsor = await this.epistery.getSponsor();
        if (sponsor && auth.rivetAddress.toLowerCase() === sponsor.toLowerCase()) {
          console.log('[wiki] Write allowed: sponsor');
          return true;
        }
      } catch (error) {
        console.error('[wiki] Permission check error:', error);
      }
    }

    console.log('[wiki] Write denied: not on any allowed list');
    return false;
  }

  /**
   * Load the document index from storage
   */
  async loadIndex() {
    if (!this.storageConfig) return;

    try {
      const indexData = JSON.parse(this.storageConfig.readFile('index.json').toString());
      if (indexData && indexData.documents) {
        this.index = new Map(Object.entries(indexData.documents));
        console.log(`[wiki] Loaded index with ${this.index.size} documents`);
      }
    } catch (error) {
      // Index doesn't exist yet - that's OK
      console.log('[wiki] No existing index found, starting fresh');
    }
  }

  /**
   * Save the document index to storage
   */
  async saveIndex() {
    if (!this.storageConfig) {
      console.error('[wiki] Cannot save index: storage not initialized');
      return;
    }

    try {
      const indexData = {
        documents: Object.fromEntries(this.index),
        updated: new Date().toISOString()
      };
      this.storageConfig.writeFile('index.json', JSON.stringify(indexData, null, 2));
    } catch (error) {
      console.error('[wiki] Failed to save index:', error);
    }
  }

  /**
   * Get document index
   */
  async getIndex(auth) {
    const results = [];
    for (const [docId, meta] of this.index) {
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
  async get(auth, docId, options = {}) {
    if (!docId) docId = this.rootDoc;

    // Check index for document metadata
    const meta = this.index.get(docId);

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

    // Load document content from IPFS/data wallet
    try {
      const content = await this.loadDocument(docId, meta);
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
   */
  async put(auth, docId, options = {}, body = {}) {
    if (!docId) throw new Error('Document ID is required');
    if (!auth || !auth.valid) throw new Error('Authentication required');

    const now = new Date().toISOString();
    const existingMeta = this.index.get(docId);

    // Prepare document
    const doc = {
      _id: docId,
      title: body.title || docId,
      body: body.body || '',
      _pid: body._pid || options._pid || '',
      visibility: body.visibility || 'public',
      listed: body.listed !== false,
      rootmenu: body.rootmenu || false,
      owner: existingMeta?.owner || auth.rivetAddress,
      _createdBy: existingMeta?._createdBy || auth.rivetAddress,
      _created: existingMeta?._created || now,
      _modified: now,
      _modifiedBy: auth.rivetAddress
    };

    // Check ownership for existing docs
    if (existingMeta && existingMeta.owner !== auth.rivetAddress) {
      // Check if user is admin
      const isAdmin = await this.epistery?.isListed(auth.rivetAddress, 'epistery::admin');
      if (!isAdmin) {
        throw new Error('Cannot modify document owned by another user');
      }
    }

    // Save document content to storage
    await this.saveDocument(docId, doc);

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
    this.index.set(docId, meta);
    await this.saveIndex();

    console.log(`[wiki] Document saved: ${docId}`);
    return doc;
  }

  /**
   * Delete a document
   */
  async delete(auth, docId) {
    if (!docId) throw new Error('Document ID is required');
    if (!auth || !auth.valid) throw new Error('Authentication required');

    const meta = this.index.get(docId);
    if (!meta) {
      throw new Error('Document not found');
    }

    // Check ownership
    if (meta.owner !== auth.rivetAddress) {
      const isAdmin = await this.epistery?.isListed(auth.rivetAddress, 'epistery::admin');
      if (!isAdmin) {
        throw new Error('Cannot delete document owned by another user');
      }
    }

    // Remove from index
    this.index.delete(docId);
    await this.saveIndex();

    // Note: IPFS content is immutable - we just remove the reference
    console.log(`[wiki] Document deleted: ${docId}`);
    return { success: true, docId };
  }

  /**
   * Load document content from storage
   */
  async loadDocument(docId, meta) {
    if (!this.storageConfig) {
      throw new Error('Storage not initialized');
    }

    try {
      const filename = `doc_${this.sanitizeFilename(docId)}.json`;
      const content = JSON.parse(this.storageConfig.readFile(filename).toString());
      return content;
    } catch (error) {
      throw new Error('Document not found');
    }
  }

  /**
   * Save document content to storage
   */
  async saveDocument(docId, doc) {
    if (!this.storageConfig) {
      throw new Error('Storage not initialized');
    }

    const content = {
      title: doc.title,
      body: doc.body,
      _pid: doc._pid
    };

    const filename = `doc_${this.sanitizeFilename(docId)}.json`;
    this.storageConfig.writeFile(filename, JSON.stringify(content, null, 2));
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
    await this.saveIndex();
  }
}
