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
   */
  static async create(type) {
    if (!type) {
      // Auto-detect based on what's configured
      type = 'config'; // Default

      try {
        const config = new Config();
        const domainConfig = config.read('/localhost');

        // Check if Storj credentials are present
        if (domainConfig.storj?.ACCESS_KEY &&
            domainConfig.storj?.SECRET_KEY &&
            domainConfig.storj?.ENDPOINT) {
          type = 'storj';
          console.log('[wiki:storage] Auto-detected Storj configuration');
        } else {
          console.log('[wiki:storage] Using Config storage (default)');
        }
      } catch (err) {
        // Error reading config, use default
        console.log('[wiki:storage] Using Config storage (default)');
      }
    }

    switch (type.toLowerCase()) {
      case 'storj':
        return await StorageFactory.createStorj();

      case 'config':
        return StorageFactory.createConfig();

      case 'ipfs':
        throw new Error('IPFS storage not yet implemented');

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
  }

  /**
   * Create Storj storage instance
   */
  static async createStorj() {
    const storage = new StorjStorage();
    await storage.initialize();
    return storage;
  }

  /**
   * Create Config storage instance (current implementation)
   */
  static createConfig() {
    const config = new Config();

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
