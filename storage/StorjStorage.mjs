import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Config } from 'epistery';

/**
 * Storj storage adapter using S3-compatible API
 * Reads credentials from epistery config
 * Stores documents under bucket/domain/ prefix
 */
export default class StorjStorage {
  constructor(domain = 'localhost') {
    this.client = null;
    this.bucket = null;
    this.domain = domain;
    this.prefix = null;
    this.initialized = false;
  }

  /**
   * Initialize Storj S3 client from config
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // Read Storj credentials from config
      const config = new Config();
      const domainConfig = config.read(`/${this.domain}`);

      // Get agent contract address as folder identifier
      const agentAddress = domainConfig.agent_contract_address;
      if (!agentAddress) {
        throw new Error('agent_contract_address not found in config');
      }

      // Read Storj credentials from config
      if (!domainConfig.storj) {
        throw new Error('Storj configuration not found in domain config');
      }

      const accessKey = domainConfig.storj.ACCESS_KEY;
      const secretKey = domainConfig.storj.SECRET_KEY;
      const endpoint = domainConfig.storj.ENDPOINT;
      const bucket = domainConfig.storj.BUCKET;

      if (!accessKey || !secretKey || !endpoint || !bucket) {
        throw new Error('Storj credentials incomplete. Required: ACCESS_KEY, SECRET_KEY, ENDPOINT, BUCKET');
      }

      this.bucket = bucket;
      this.prefix = `${agentAddress}/wiki/`;

      this.client = new S3Client({
        endpoint: endpoint,
        region: 'us-east-1', // Storj doesn't use regions, but S3 client requires it
        credentials: {
          accessKeyId: accessKey,
          secretAccessKey: secretKey
        },
        forcePathStyle: true // Required for Storj
      });

      this.initialized = true;
      console.log(`[wiki:storj] Initialized: ${this.bucket}/${this.prefix}`);
    } catch (error) {
      console.error('[wiki:storj] Failed to initialize:', error.message);
      throw error;
    }
  }

  /**
   * Save a file to Storj
   */
  async writeFile(key, content) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: typeof content === 'string' ? Buffer.from(content) : content,
        ContentType: key.endsWith('.json') ? 'application/json' : 'text/plain'
      });

      await this.client.send(command);
      console.log(`[wiki:storj] Wrote: ${fullKey}`);
      return true;
    } catch (error) {
      console.error(`[wiki:storj] Failed to write ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Read a file from Storj
   */
  async readFile(key) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey
      });

      const response = await this.client.send(command);
      const chunks = [];

      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);
      console.log(`[wiki:storj] Read: ${fullKey} (${buffer.length} bytes)`);
      return buffer;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error(`File not found: ${key}`);
      }
      console.error(`[wiki:storj] Failed to read ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Check if a file exists in Storj
   */
  async exists(key) {
    await this.initialize();

    try {
      const fullKey = this.prefix + key;
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * List files with a prefix
   */
  async listFiles(prefix = '') {
    await this.initialize();

    try {
      const fullPrefix = this.prefix + prefix;
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix
      });

      const response = await this.client.send(command);
      // Strip domain prefix from returned keys
      return (response.Contents || []).map(item =>
        item.Key.startsWith(this.prefix) ? item.Key.slice(this.prefix.length) : item.Key
      );
    } catch (error) {
      console.error(`[wiki:storj] Failed to list files:`, error.message);
      throw error;
    }
  }
}
