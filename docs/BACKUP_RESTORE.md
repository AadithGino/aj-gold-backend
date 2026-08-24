# Backup and Restore

## Backup (disposable/demo/test only)

```bash
export MONGO_URI=mongodb://127.0.0.1:27017/ajgold_demo?replicaSet=rs0
npm run backup:db
```

Requires MongoDB Database Tools (`mongodump`).

## Restore

```bash
export MONGO_URI=mongodb://127.0.0.1:27017/ajgold_demo?replicaSet=rs0
export ALLOW_DATABASE_RESET=true
export CONFIRM_DATABASE_RESET=ajgold_demo
export RESTORE_ARCHIVE=./backups/ajgold_demo-<timestamp>.archive.gz
export RESTORE_DROP=true
npm run restore:db
npm run migrate:verify
npm run verify:indexes
npm run integrity:scan
```

A restore drill is only considered successful after restore **and** verification commands pass on a disposable database.
