# Migrating Wiki Documents from Metric/MongoDB to Epistery

This document describes the process of migrating wiki documents from the legacy Metric wiki (MongoDB-based) to the new Epistery wiki system.

## Overview

The Epistery wiki stores documents using the `epistery` Config system, which provides a local-first storage layer with planned Storj.io cloud backup. Documents are stored as JSON files locally and indexed for hierarchical browsing.

## Key Differences from Legacy Wiki

### Deprecated Features
- **Visibility/ACL**: The `visibility` field (e.g., `visibility: "sprague"`) is deprecated. All documents should be migrated with `visibility: "public"`. Access control will be reimplemented if needed based on usage patterns.

### Storage Location
- Documents are stored in `~/.epistery/wiki/` as individual JSON files
- Format: `doc_<DocumentName>.json`
- An `index.json` file maintains metadata for all documents
- Storj.io integration is in development but currently falls back to local storage

### Document Structure
MongoDB documents have this structure:
```json
{
  "_id": {"d": "DocumentName", "a": "author"},
  "_created": "ISO date",
  "_modified": "ISO date",
  "_pid": "ParentDocument",
  "body": "Markdown content",
  "visibility": "sprague",
  "listed": true
}
```

Epistery wiki documents:
```json
{
  "title": "DocumentName",
  "body": "Markdown content",
  "_pid": "ParentDocument",
  "visibility": "public",
  "listed": true
}
```

## Migration Procedure

### 1. Extract Documents from MongoDB

Use `mongosh` with `JSON.stringify()` to export valid JSON:

```bash
mongosh "mongodb://user:pass@host:port/database?authSource=admin" \
  --quiet \
  --eval 'JSON.stringify(db.wiki.find({_pid: {$in: ["ParentDoc1", "ParentDoc2"]}}).toArray())' \
  > /tmp/documents.json
```

**Important**: Don't use `.toArray()` directly as it produces MongoDB extended JSON that isn't valid JavaScript JSON.

### 2. Upload Using Epistery CLI

The migration script uses `epistery curl` which provides Bot authentication:

```bash
#!/bin/bash
jq -c '.[]' /tmp/documents.json | while read -r doc; do
  docId=$(echo "$doc" | jq -r '._id.d')
  title="$docId"
  body=$(echo "$doc" | jq -r '.body // ""')
  pid=$(echo "$doc" | jq -r '._pid // ""')
  listed=$(echo "$doc" | jq -r '.listed // true')

  # Force visibility to public (deprecated field)
  visibility="public"

  payload=$(jq -n \
    --arg title "$title" \
    --arg body "$body" \
    --arg pid "$pid" \
    --arg visibility "$visibility" \
    --argjson listed "$listed" \
    '{title: $title, body: $body, _pid: $pid, visibility: $visibility, listed: $listed}')

  epistery curl -w localhost -X PUT -d "$payload" \
    "http://localhost:4080/agent/epistery/wiki/$docId"
done
```

### 3. Verify Migration

Check the index:
```bash
curl -s "http://localhost:4080/agent/epistery/wiki/index" | jq 'length'
```

Verify specific documents are accessible:
```bash
curl -s -H "Accept: application/json" \
  "http://localhost:4080/agent/epistery/wiki/DocumentName" | jq '.title'
```

Check local storage:
```bash
ls ~/.epistery/wiki/doc_*.json | wc -l
cat ~/.epistery/wiki/index.json | jq '.documents | length'
```

## Common Issues and Solutions

### Issue: Documents Upload But Return 404

**Symptom**: Upload succeeds but GET returns `{"error":"Document not found"}`

**Causes**:
1. Document has `visibility: "sprague"` or other non-public value
2. In-memory index hasn't reloaded after manual edits

**Solution**:
Update all documents to public visibility:
```bash
cd ~/.epistery/wiki
jq '(.documents | to_entries | map(.value.visibility = "public") | from_entries) as $docs | .documents = $docs' \
  index.json > index.new.json
mv index.new.json index.json
```

Then restart epistery-host to reload the index.

### Issue: Storj Shows 0 KB Files

**Status**: Storj.io integration is in development. Documents currently save to local storage (`~/.epistery/wiki/`) successfully. The wiki agent falls back gracefully to local storage when Storj sync fails.

**Impact**: None for development. Documents work correctly from local storage.

### Issue: Migration Script Shows Success But Documents Missing

**Diagnosis**:
```bash
# Check what actually got uploaded
ls ~/.epistery/wiki/doc_*.json | wc -l

# Compare to source
jq '. | length' /tmp/documents.json
```

**Causes**:
- Script completed but some uploads failed silently
- Index not reloaded

**Solution**: Use the comprehensive migration script at `/tmp/migrate-wiki.sh` which validates each upload.

## Production Migration Script

See `/tmp/migrate-wiki.sh` for a production-ready script that:
- Validates successful uploads
- Logs all operations
- Sets proper visibility (public)
- Verifies documents are retrievable after upload
- Provides success/failure counts

Usage:
```bash
./migrate-wiki.sh \
  "mongodb://user:pass@host:port/db?authSource=admin" \
  "database_name" \
  "collection_name" \
  '{_pid: {$in: ["Parent1", "Parent2"]}}' \
  "http://localhost:4080/agent/epistery/wiki" \
  "localhost"
```

## Important Notes

### Server Address vs Domain
The storage path uses `localhost` as the domain. For production:
- Use the server's actual address/domain as the folder name
- This prevents conflicts when multiple developers work on different wikis
- Example: `~/.epistery/wiki.rootz.global/` instead of `~/.epistery/localhost/`

### Hierarchical Documents
The wiki supports parent-child relationships via `_pid`:
- Set `_pid: ""` or omit for root-level documents
- Set `_pid: "ParentDocName"` for children
- The UI renders a collapsible tree in the sidebar

### Authentication
- `epistery curl -w <wallet>` uses Bot authentication
- Each request is signed with the wallet's private key
- Localhost automatically allows writes during development
- No session management needed

## Testing Your Migration

After migration:

1. **Check the index loads**: Visit `http://localhost:4080/agent/epistery/wiki/`
2. **Verify tree structure**: Expand parent documents in sidebar
3. **Test WikiWords**: Internal links like `[DocumentName]` should work
4. **Edit a document**: Ensure the editor loads and saves properly
5. **Check visibility**: All documents should be publicly readable

## Migration Checklist

- [ ] Export documents from MongoDB using `JSON.stringify()`
- [ ] Verify JSON is valid (not MongoDB extended JSON)
- [ ] Run migration script with visibility set to "public"
- [ ] Check document count matches source
- [ ] Verify documents are accessible via API
- [ ] Test document tree rendering in UI
- [ ] Restart epistery-host after any manual index.json edits
- [ ] Update parent documents (master lists) if needed
- [ ] Test WikiWord links between documents

## Future Improvements

1. **Storj Integration**: Complete the cloud storage sync
2. **Batch Operations**: API endpoint for bulk uploads
3. **Migration Tool**: CLI tool built into epistery package
4. **Visibility Control**: Reimplement if usage requires access control
5. **Server Addressing**: Use proper server address instead of "localhost" for storage paths
