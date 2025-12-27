import { Config } from 'epistery';
import StorjStorage from './StorjStorage.mjs';

/**
 * Storage factory that creates the appropriate storage backend
 * based on configuration
 */
export default class StorageFactory {
  /**
   * Create storage instance based on config
   * @param {string} type - Storage type: 'config', 'storj', 'ipfs'
   * @param {string} domain - Domain name for config-based storage
   */
  static async create(type, domain = 'localhost') {
    if (!type) {
      // Auto-detect based on what's configured - prefer Storj
      type = 'storj'; // Default to storj

      try {
        const config = new Config();
        const domainConfig = config.read(`/${domain}`);

        // Check if Storj credentials are present
        if (domainConfig.storj?.ACCESS_KEY &&
            domainConfig.storj?.SECRET_KEY &&
            domainConfig.storj?.ENDPOINT) {
          type = 'storj';
          console.log('[wiki:storage] Using Storj storage');
        } else {
          type = 'config';
          console.log('[wiki:storage] Storj not configured, falling back to Config storage');
        }
      } catch (err) {
        // Error reading config, use config storage
        type = 'config';
        console.log('[wiki:storage] Config read error, using Config storage (default)');
      }
    }

    switch (type.toLowerCase()) {
      case 'storj':
        return await StorageFactory.createStorj(domain);

      case 'config':
        return StorageFactory.createConfig(domain);

      case 'ipfs':
        throw new Error('IPFS storage not yet implemented');

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
  }

  /**
   * Create Storj storage instance
   * @param {string} domain - Domain name for config lookup
   */
  static async createStorj(domain = 'localhost') {
    const storage = new StorjStorage(domain);
    await storage.initialize();
    return storage;
  }

  /**
   * Create Config storage instance (current implementation)
   * @param {string} domain - Domain name for path prefix
   */
  static createConfig(domain = 'localhost') {
    const config = new Config();
    config.setPath(`/${domain}/wiki`);

    // Wrap Config with the same interface as other storage backends
    return {
      writeFile: (key, content) => {
        config.writeFile(key, content);
        return Promise.resolve(true);
      },

      readFile: (key) => {
        return Promise.resolve(config.readFile(key));
      },

      exists: (key) => {
        try {
          config.readFile(key);
          return Promise.resolve(true);
        } catch (error) {
          return Promise.resolve(false);
        }
      },

      listFiles: (prefix) => {
        // Config doesn't support listing, return empty array
        return Promise.resolve([]);
      }
    };
  }
}
