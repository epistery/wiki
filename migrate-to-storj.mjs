#!/usr/bin/env node
/**
 * Migrate wiki documents from Config storage to Storj storage
 *
 * Usage: node migrate-to-storj.mjs
 */

import { Config } from 'epistery';
import StorageFactory from '../epistery-host/utils/storage/StorageFactory.mjs';

async function migrate() {
  console.log('Wiki Storage Migration: Config -> Storj\n');

  // Load from Config storage
  console.log('1. Loading documents from Config storage...');
  const configStorage = StorageFactory.createConfig();

  let index;
  try {
    const indexBuffer = await configStorage.readFile('index.json');
    index = JSON.parse(indexBuffer.toString());
    console.log(`   Found ${Object.keys(index.documents || {}).length} documents in index`);
  } catch (error) {
    console.error('   Error: Could not read index.json from Config storage');
    console.error('   ', error.message);
    return;
  }

  // Initialize Storj storage
  console.log('\n2. Initializing Storj storage...');
  let storjStorage;
  try {
    storjStorage = await StorageFactory.create('storj');
    console.log('   Storj storage initialized');
  } catch (error) {
    console.error('   Error: Could not initialize Storj storage');
    console.error('   ', error.message);
    console.error('\n   Make sure you have configured Storj credentials in config.ini:');
    console.error('   [storj]');
    console.error('   ACCESS_KEY=your-key');
    console.error('   SECRET_KEY=your-secret');
    console.error('   ENDPOINT=https://gateway.storjshare.io');
    return;
  }

  // Migrate index
  console.log('\n3. Migrating index.json...');
  try {
    await storjStorage.writeFile('index.json', JSON.stringify(index, null, 2));
    console.log('   ✓ index.json migrated');
  } catch (error) {
    console.error('   Error migrating index:', error.message);
    return;
  }

  // Migrate each document
  console.log('\n4. Migrating documents...');
  const docIds = Object.keys(index.documents || {});
  let migrated = 0;
  let failed = 0;

  for (const docId of docIds) {
    const sanitized = docId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `doc_${sanitized}.json`;

    try {
      // Read from Config
      const content = await configStorage.readFile(filename);

      // Write to Storj
      await storjStorage.writeFile(filename, content);

      console.log(`   ✓ ${docId}`);
      migrated++;
    } catch (error) {
      console.error(`   ✗ ${docId}: ${error.message}`);
      failed++;
    }
  }

  // Summary
  console.log('\n5. Migration Summary:');
  console.log(`   Total documents: ${docIds.length}`);
  console.log(`   Migrated: ${migrated}`);
  console.log(`   Failed: ${failed}`);

  if (failed === 0) {
    console.log('\n✓ Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Restart epistery-host to use Storj storage');
    console.log('2. Verify documents are accessible');
    console.log('3. Optionally delete old Config storage files');
  } else {
    console.log('\n⚠ Migration completed with errors');
    console.log('Check the errors above and retry if needed');
  }
}

migrate().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
