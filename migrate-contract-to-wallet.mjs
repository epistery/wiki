import { S3Client, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { Config } from 'epistery';

/**
 * Migrate wiki data from old contract-based prefix to server wallet prefix
 * Usage: node migrate-contract-to-wallet.mjs [domain] [oldContractAddress]
 */

const domain = process.argv[2] || 'localhost';
const oldContract = process.argv[3] || '0xA555f00a4A83C109e2629b78de7D803790eE43C6';

console.log(`Migrating wiki data for domain: ${domain}`);
console.log(`From contract: ${oldContract}`);

const config = new Config();
const domainConfig = config.read(`/${domain}`);

const serverWallet = domainConfig.wallet?.address;
if (!serverWallet) {
  throw new Error('Server wallet address not found in config');
}

console.log(`To server wallet: ${serverWallet}`);

const client = new S3Client({
  endpoint: domainConfig.storj.ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: domainConfig.storj.ACCESS_KEY,
    secretAccessKey: domainConfig.storj.SECRET_KEY
  },
  forcePathStyle: true
});

const bucket = domainConfig.storj.BUCKET;
const oldPrefix = `${oldContract}/wiki/`;
const newPrefix = `${serverWallet}/wiki/`;

console.log(`\nOld prefix: ${oldPrefix}`);
console.log(`New prefix: ${newPrefix}\n`);

// List all files under old prefix
const listResponse = await client.send(new ListObjectsV2Command({
  Bucket: bucket,
  Prefix: oldPrefix
}));

const files = listResponse.Contents || [];
console.log(`Found ${files.length} files to migrate\n`);

// Copy each file to new location
for (const file of files) {
  const oldKey = file.Key;
  const relativePath = oldKey.substring(oldPrefix.length);
  const newKey = newPrefix + relativePath;

  console.log(`Copying: ${relativePath}`);

  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${oldKey}`,
    Key: newKey
  }));
}

console.log(`\nMigration complete! Copied ${files.length} files.`);
console.log(`Old files remain at ${oldPrefix} (you can delete them manually if desired)`);
