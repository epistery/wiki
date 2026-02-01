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
        console.log(`[wiki] No existing index for ${domain}, rebuilding from documents...`);
        await this.rebuildIndex(storage, index);
      }

      this.domainStates.set(domain, { storage, index });
    }
    return this.domainStates.get(domain);
  }

  /**
   * Rebuild index by scanning all doc_*.json files
   */
  async rebuildIndex(storage, index) {
    try {
      const files = await storage.listFiles();
      let rebuilt = 0;

      for (const filename of files) {
        // Match doc_*.json files
        const match = filename.match(/^doc_(.+)\.json$/);
        if (!match) continue;

        const docId = match[1].replace(/_/g, '');

        try {
          const content = JSON.parse((await storage.readFile(filename)).toString());
          content._id = docId;
          const meta = this.createIndexMeta(content);
          index.set(docId, meta);
          rebuilt++;
        } catch (err) {
          console.error(`[wiki] Failed to rebuild index entry for ${filename}:`, err.message);
        }
      }

      if (rebuilt > 0) {
        console.log(`[wiki] Rebuilt index with ${rebuilt} documents`);
        // Save the rebuilt index
        const indexData = {
          documents: Object.fromEntries(index),
          updated: new Date().toISOString()
        };
        await storage.writeFile('index.json', JSON.stringify(indexData, null, 2));
      } else {
        console.log(`[wiki] No documents found, starting with empty index`);
      }
    } catch (error) {
      console.error('[wiki] Failed to rebuild index:', error);
    }
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

    // Serve client directory statically
    router.use('/client',express.static(path.join(__dirname, 'client')));

    // Serve widget (for host agent box)
    router.get('/widget', (req, res) => {
      const widgetPath = path.join(__dirname, 'client/widget.html');
      if (!existsSync(widgetPath)) {
        return res.status(404).send('Widget not found');
      }
      res.sendFile(widgetPath);
    });

    // Serve admin page for host
    router.get('/admin', (req, res) => {
      const adminPath = path.join(__dirname, 'client/admin.html');
      if (!existsSync(adminPath)) {
        return res.status(404).send('Admin page not found');
      }
      res.sendFile(adminPath);
    });

    // Wiki index endpoint - list all documents
    router.get('/index', async (req, res) => {
      try {
        const index = await this.getIndex(req.episteryClient, req.wikiState);
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
        // this needs to be loaded from manifest, not hardcoded. Version should come from epistery-host agent manager
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
        const permissions = await this.getPermissions(req)

        // GET - read document (no auth required for public docs)
        if (method === 'get' && permissions.read) {
          // Check Accept header - serve HTML for browsers, JSON for API
          if (req.accepts('html')) {
            // Serve the wiki page viewer
            const pagePath = path.join(__dirname, 'client/page.html');
            if (existsSync(pagePath)) {
              return res.sendFile(pagePath);
            }
          }

          // Read _pid from cookie for new documents (like wiki-mixin does)
          const pidFromCookie = req.cookies?._pid || '';
          const options = { _pid: pidFromCookie, ...req.query };

          const doc = await this.get(req.episteryClient, docId, options, req.wikiState);

          // Set cookie for next navigation (like wiki-mixin does)
          const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
          res.cookie('_pid', docId, { expires, sameSite: 'Strict' });

          if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
          }

          // Add write permission flag to response for display purposes
          doc.__permissions = permissions

          res.json(doc);
          return;
        }

        // POST or PUT - create/update document (auth required)
        // Both methods accepted so "post to the wiki" works naturally
        if ((method === 'post' || method === 'put') && permissions.edit) {
          if (!/^[A-Za-z0-9_]{3,}$/.test(docId)) return res.status(405).json({ error: 'Invalid document ID' });
          const doc = await this.put(req.episteryClient, docId, req.query, req.body, req.wikiState);
          doc.__permissions = permissions
          res.json(doc);
          return;
        }

        // DELETE - remove document (auth required)
        if (method === 'delete' && (permissions.admin || req.episteryClient.address === docId._createdBy)) {
          const result = await this.delete(req.episteryClient, docId, req.wikiState);
          res.json(result);
          return;
        }

        // Access denied - show friendly message for HTML requests
        if (req.accepts(['html', 'json']) === 'html') {
          return res.status(403).send(`
            <!DOCTYPE html>
            <html><head><title>Access Denied</title></head>
            <body style="font-family: sans-serif; max-width: 600px; margin: 100px auto; text-align: center;">
              <h1>Access Denied</h1>
              <p>Browser address: <span style='font-family:monospace;font-weight:bold'>${req.episteryClient.address}</p>
              <p>Access unavailable. Please contact the administrator.</p>
            </body></html>
          `);
        }
        return res.status(403).json({ error: 'Permission required' });
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
   * return edit/admin privileges from white list
   */
  async getPermissions(req) {
    const result = {admin:false,edit:false,read:true};

    // Everyone has read access by default
    if (!req.episteryClient || !this.epistery) {
      return result;
    }

    try {
      const isAdmin = await this.epistery.isListed(req.episteryClient.address, 'epistery::admin');
      result.admin = isAdmin;
      result.edit = isAdmin;  // admins can edit
      return result;
    } catch (error) {
      console.error('[wiki] ACL check error:', error);
    }
    return result;
  }

  /**
   * Create index metadata from document
   */
  createIndexMeta(doc) {
    return {
      title: doc.title || doc._id,
      _pid: doc._pid || '',
      visibility: doc.visibility || 'public',
      listed: doc.listed !== false,
      rootmenu: doc.rootmenu || false,
      owner: doc.owner || doc._createdBy || 'unknown',
      _createdBy: doc._createdBy || 'unknown',
      _created: doc._created || new Date().toISOString(),
      _modified: doc._modified || doc._created || new Date().toISOString(),
      _modifiedBy: doc._modifiedBy || doc._createdBy || 'unknown'
    };
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
  async getIndex(episteryClient, wikiState) {
    if (!episteryClient) throw new Error('Authentication required');
    const results = [];
    for (const [docId, meta] of wikiState.index) {
      // Filter by visibility
      if (meta.visibility === 'public' || (episteryClient?.address === meta.owner)) {
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
  async get(episteryClient, docId, options = {}, wikiState) {
    if (!docId) docId = this.rootDoc;
    if (!episteryClient) throw new Error('Authentication required');

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
      if (episteryClient && episteryClient.address !== meta.owner) {
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
  async put(episteryClient, docId, options = {}, body = {}, wikiState) {
    if (!docId) throw new Error('Document ID is required');
    if (!episteryClient) throw new Error('Authentication required');

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
      owner: existingMeta?.owner || episteryClient?.address, // Track original creator
      _createdBy: existingMeta?._createdBy || episteryClient?.address,
      _created: existingMeta?._created || now,
      _modified: now,
      _modifiedBy: episteryClient?.address // Track who made this edit
    };

    // Save document content to storage
    await this.saveDocument(docId, doc, wikiState);

    // Update index
    const meta = this.createIndexMeta(doc);
    wikiState.index.set(docId, meta);
    await this.saveIndex(wikiState);

    console.log(`[wiki] Document saved: ${docId} (edited by ${episteryClient.address})`);
    return doc;
  }

  /**
   * Delete a document
   * Only epistery::admin can delete documents (more restrictive than edit)
   */
  async delete(episteryClient, docId, wikiState) {
    if (!docId) throw new Error('Document ID is required');
    if (!episteryClient) throw new Error('Authentication required');

    const meta = wikiState.index.get(docId);
    if (!meta) {
      throw new Error('Document not found');
    }

    // Only admins can delete documents
    // Note: epistery.isListed() handles sponsor fallback internally
    const isAdmin = await this.epistery?.isListed(episteryClient.address, 'epistery::admin');
    if (!isAdmin) {
      throw new Error('Only epistery::admin can delete documents');
    }

    // Remove from index
    wikiState.index.delete(docId);
    await this.saveIndex(wikiState);

    console.log(`[wiki] Document deleted: ${docId} (by ${episteryClient.address})`);
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
