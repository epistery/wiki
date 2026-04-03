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
    // Per-domain state (keyed by domain)
    this.domainStates = new Map();
  }

  /**
   * Get or initialize domain state (storage and index)
   */
  async getDomainState(domain) {
    if (!this.domainStates.has(domain)) {
      const storage = await this.config.getStorage(domain, 'wiki');
      const index = new Map();

      // Load index from storage
      try {
        const indexData = JSON.parse((await storage.readFile('index.json')).toString());
        if (indexData && indexData.documents) {
          Object.entries(indexData.documents).forEach(([k, v]) => index.set(k, v));
        }
      } catch (error) {
        // index.json missing or unreadable
      }

      // Reconcile: scan storage for doc files missing from the index
      await this.reconcileIndex(storage, index);

      this.domainStates.set(domain, { storage, index });
    }
    return this.domainStates.get(domain);
  }

  /**
   * Reconcile index against actual doc files in storage.
   * Adds any doc_*.json files not present in the index.
   */
  async reconcileIndex(storage, index) {
    try {
      const files = await storage.listFiles();
      let added = 0;

      for (const filename of files) {
        const match = filename.match(/^doc_(.+)\.json$/);
        if (!match) continue;

        const docId = match[1].replace(/_/g, '');
        if (index.has(docId)) continue;

        try {
          const content = JSON.parse((await storage.readFile(filename)).toString());
          content._id = docId;
          index.set(docId, this.createIndexMeta(content));
          added++;
        } catch (err) {
          console.error(`[wiki] Failed to index ${filename}:`, err.message);
        }
      }

      if (added > 0) {
        console.log(`[wiki] Reconciled index: added ${added} missing documents`);
        await this.saveIndex({ storage, index });
      }
    } catch (error) {
      console.error('[wiki] Failed to reconcile index:', error);
    }
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
        // Save the rebuilt index
        const indexData = {
          documents: Object.fromEntries(index),
          updated: new Date().toISOString()
        };
        await storage.writeFile('index.json', JSON.stringify(indexData, null, 2));
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
        const permissions = await this.getPermissions(req);
        if (!permissions.read) {
          return res.status(403).json({ error: 'Access denied', enableRequestAccess: permissions.enableRequestAccess });
        }
        const index = await this.getIndex(req.episteryClient, req.wikiState, req.domainAcl);
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

    // ACL list names for visibility dropdown
    router.get('/acl-lists', async (req, res) => {
      try {
        const contract = req.domainAcl?.chain?.contract;
        if (!contract) return res.json({ lists: [] });
        const names = await contract.getListNames();
        res.json({ lists: Array.from(names) });
      } catch (error) {
        console.error('[wiki] acl-lists error:', error.message);
        res.json({ lists: [] });
      }
    });

    // Wiki document CRUD handler
    const handleDocument = async (req, res) => {
      try {
        const method = req.method.toLowerCase();
        const docId = req.params.docId || this.rootDoc;

        // Always serve the wiki SPA for browser navigation (HTML requests).
        // common.js must load to establish the epistery session; without it,
        // expired sessions land on a bare 403 page with no way to recover.
        // The actual document data is still gated by permissions on the JSON API.
        if (method === 'get' && req.accepts('html')) {
          const pagePath = path.join(__dirname, 'client/page.html');
          if (existsSync(pagePath)) {
            return res.sendFile(pagePath);
          }
        }

        const permissions = await this.getPermissions(req)

        // GET - read document (JSON API)
        if (method === 'get' && permissions.read) {

          // Read _pid from cookie for new documents (like wiki-mixin does)
          const pidFromCookie = req.cookies?._pid || '';
          const options = { _pid: pidFromCookie, ...req.query };

          const doc = await this.get(req.episteryClient, docId, options, req.wikiState, req.domainAcl);

          // Set cookie for next navigation (like wiki-mixin does)
          const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
          res.cookie('_pid', docId, { expires, sameSite: 'Strict' });

          if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
          }
          if (doc._restricted) {
            return res.status(403).json({ error: 'Document exists but is not accessible to you' });
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
          const doc = await this.put(req.episteryClient, docId, req.query, req.body, req.wikiState, req.domainAcl);
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
          const address = req.episteryClient?.address || '';
          const addressDisplay = address ? `${address.slice(0,8)}...${address.slice(-6)}` : 'unknown';
          return res.status(403).send(`
            <!DOCTYPE html>
            <html><head><title>Access Denied</title></head>
            <body style="font-family: sans-serif; max-width: 600px; margin: 100px auto; text-align: center;">
              <h1>Access Denied</h1>
              <p>Browser address: <span style='font-family:monospace;font-weight:bold'>${addressDisplay}</span></p>
              <p>You do not have access to this wiki.</p>
              <div id="requestForm" style="margin-top:24px;${address ? '' : 'display:none'}">
                <input type="text" id="requestName" placeholder="Name (optional)" style="width:100%;padding:8px;margin-bottom:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;">
                <textarea id="requestMessage" placeholder="Message for the host (optional)" style="width:100%;min-height:60px;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;margin-bottom:8px;font-family:inherit;resize:vertical"></textarea>
                <button onclick="submitRequest()" style="padding:8px 24px;background:#2d5016;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px">Request Access</button>
              </div>
              <p id="statusMsg" style="margin-top:16px"></p>
              <script>
                async function submitRequest() {
                  try {
                    const resp = await fetch('/api/acl/request-access', {
                      method: 'POST',
                      headers: {'Content-Type':'application/json'},
                      body: JSON.stringify({
                        address: '${address}',
                        listName: 'epistery::reader',
                        agentName: '@epistery/wiki',
                        name: document.getElementById('requestName').value.trim(),
                        message: document.getElementById('requestMessage').value.trim()
                      })
                    });
                    if (resp.ok) {
                      document.getElementById('requestForm').style.display = 'none';
                      document.getElementById('statusMsg').textContent = 'Access request submitted. Please wait for approval.';
                    } else {
                      const err = await resp.json();
                      document.getElementById('statusMsg').textContent = err.error || 'Request failed';
                    }
                  } catch(e) {
                    document.getElementById('statusMsg').textContent = 'Request failed: ' + e.message;
                  }
                }
              </script>
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
    const result = {admin:false, edit:false, read:false, enableRequestAccess:false};

    if (!req.episteryClient || !req.domainAcl) {
      return result;
    }

    try {
      const access = await req.domainAcl.checkAgentAccess('@epistery/wiki', req.episteryClient.address, req.hostname);
      result.admin = access.level >= 3;
      result.edit = access.level >= 2;
      result.read = access.level >= 1;
      result.enableRequestAccess = access.enableRequestAccess;
      return result;
    } catch (error) {
      console.error('[wiki] ACL check error:', error);
    }
    return result;
  }

  /**
   * Get the ACL lists a user belongs to.
   * Caches on episteryClient._wikiUserLists to avoid redundant contract calls.
   */
  async getUserLists(episteryClient, domainAcl) {
    if (episteryClient._wikiUserLists) return episteryClient._wikiUserLists;
    const lists = new Set();
    try {
      const contract = domainAcl?.chain?.contract;
      if (contract && episteryClient?.address) {
        const memberships = await contract.getListsForMember(episteryClient.address);
        for (const entry of memberships) {
          lists.add(entry.listName);
        }
      }
    } catch (err) {
      console.error('[wiki] getUserLists error:', err.message);
    }
    episteryClient._wikiUserLists = lists;
    return lists;
  }

  /**
   * Check whether a user can access a document given its visibility.
   * 'default' / 'public' (legacy) → anyone with wiki read access
   * 'private' → owner only
   * anything else → ACL list name, check userLists membership
   */
  canAccess(visibility, ownerAddress, userAddress, userLists) {
    if (!visibility || visibility === 'default' || visibility === 'public') return true;
    if (userAddress && userAddress === ownerAddress) return true;
    if (visibility === 'private') return false;
    // Treat as ACL list name
    return userLists.has(visibility);
  }

  /**
   * Create index metadata from document
   */
  createIndexMeta(doc) {
    return {
      title: doc.title || doc._id,
      _pid: doc._pid || '',
      visibility: doc.visibility || 'default',
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
  async getIndex(episteryClient, wikiState, domainAcl) {
    if (!episteryClient) throw new Error('Authentication required');
    const userLists = await this.getUserLists(episteryClient, domainAcl);
    const results = [];
    for (const [docId, meta] of wikiState.index) {
      if (this.canAccess(meta.visibility, meta.owner, episteryClient?.address, userLists)) {
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
  async get(episteryClient, docId, options = {}, wikiState, domainAcl) {
    if (!docId) docId = this.rootDoc;
    if (!episteryClient) throw new Error('Authentication required');

    // Check index for document metadata
    const meta = wikiState.index.get(docId);

    if (!meta) {
      // Document doesn't exist - inherit visibility from parent
      const parentId = options._pid || '';
      const parentMeta = parentId ? wikiState.index.get(parentId) : null;
      const inheritedVisibility = parentMeta?.visibility || 'default';
      return {
        _id: docId,
        title: docId,
        body: `# ${docId}\n`,
        _pid: parentId,
        visibility: inheritedVisibility,
        _new: true
      };
    }

    // Check visibility
    const userLists = await this.getUserLists(episteryClient, domainAcl);
    if (!this.canAccess(meta.visibility, meta.owner, episteryClient?.address, userLists)) {
      return { _id: docId, _restricted: true };
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
  async put(episteryClient, docId, options = {}, body = {}, wikiState, domainAcl) {
    if (!docId) throw new Error('Document ID is required');
    if (!episteryClient) throw new Error('Authentication required');

    const now = new Date().toISOString();
    const existingMeta = wikiState.index.get(docId);

    // Block saving over a document the user cannot access
    if (existingMeta) {
      const userLists = await this.getUserLists(episteryClient, domainAcl);
      if (!this.canAccess(existingMeta.visibility, existingMeta.owner, episteryClient?.address, userLists)) {
        throw new Error('Document exists but is not accessible to you');
      }
    }

    // Prepare document
    const doc = {
      _id: docId,
      title: body.title || docId,
      body: body.body || '',
      _pid: body._pid || options._pid || '',
      visibility: body.visibility || 'default',
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

    return doc;
  }

  /**
   * Delete a document
   * Only admins can delete documents (more restrictive than edit)
   */
  async delete(episteryClient, docId, wikiState) {
    if (!docId) throw new Error('Document ID is required');
    if (!episteryClient) throw new Error('Authentication required');

    const meta = wikiState.index.get(docId);
    if (!meta) {
      throw new Error('Document not found');
    }

    // Remove from index
    wikiState.index.delete(docId);
    await this.saveIndex(wikiState);

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
   * Contribute to /.well-known/ai discovery response.
   * Returns public, listed pages for this domain.
   */
  async aiDiscovery(domain) {
    try {
      const state = await this.getDomainState(domain);
      const items = [];
      for (const [docId, meta] of state.index) {
        if ((meta.visibility === 'public' || meta.visibility === 'default') && meta.listed !== false) {
          items.push({
            id: docId,
            title: meta.title || docId,
            modified: meta._modified || null,
            url: `/agent/epistery/wiki/${docId}`
          });
        }
      }
      return { content: { type: 'pages', items } };
    } catch (err) {
      console.error('[wiki] aiDiscovery error:', err.message);
      return {};
    }
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
