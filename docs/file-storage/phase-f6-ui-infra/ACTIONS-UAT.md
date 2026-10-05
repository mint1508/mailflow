# F6-02 Actions UAT

Run against a deployed API with an authenticated dev fixture or access token:

```sh
FILE_UAT_OUTPUT=artifacts/file-pwa/f6/actions-uat.json \
node scripts/file-pwa-contract-uat.mjs --suite actions
```

The suite creates an owned folder and file, verifies attachment download and safe inline preview, checks search, moves the file to Trash, lists Trash, restores it, and records cross-user denial. The artifact records request IDs/status codes and never stores credentials or provider URLs.
