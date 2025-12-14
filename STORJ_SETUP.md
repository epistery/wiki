# Storj Storage Setup

The wiki agent supports multiple storage backends:
- **Config** - Local file storage via epistery Config (default)
- **Storj** - Cloud object storage via Storj DCS
- **IPFS** - (planned) Decentralized storage

## Storj Configuration

To use Storj storage, add the following to your `localhost/config.ini`:

```ini
[storj]
ACCESS_KEY=your-access-key-here
SECRET_KEY=your-secret-key-here
ENDPOINT=https://gateway.storjshare.io
BUCKET=epistery-wiki
```

### Getting Storj Credentials

1. Sign up at https://www.storj.io/
2. Create a new project
3. Generate S3 credentials in the Access page
4. Create a bucket named `epistery-wiki` (or use a different name and set it in config)

The wiki will automatically detect Storj configuration and use it if available. Otherwise, it falls back to Config storage.

## Manual Storage Selection

You can explicitly set the storage backend in the agent configuration:

```javascript
{
  storage: 'storj'  // or 'config', 'ipfs'
}
```

## Storage Backend Implementation

Storj storage uses the AWS S3-compatible API via `@aws-sdk/client-s3`. This provides:
- Reliable cloud storage with encryption
- Geographic distribution
- Decentralized architecture
- S3-compatible interface

Documents are stored as JSON files:
- `index.json` - Document metadata index
- `doc_<sanitized-id>.json` - Individual document content

## Testing

After configuring Storj credentials, restart the epistery-host and check logs:

```bash
[wiki:storage] Auto-detected Storj configuration
[wiki:storj] Initialized with bucket: epistery-wiki
[wiki] Storage initialized
```

Documents created/edited will now be stored in Storj instead of local Config storage.
