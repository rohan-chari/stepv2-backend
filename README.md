# Bara Backend

Node/Express/Prisma/PostgreSQL backend for Bara.

## Local development

Install dependencies and use the local/test environment configured outside git.

```bash
npm install
npx prisma generate
npm run test:unit
```

Use the dedicated integration runner for integration work. Never point tests at
production.

## Canonical documentation

- **Live operations, deploys, backups, rollback:** [OPERATIONS.md](OPERATIONS.md)
- **Agent engineering policy:** [AGENTS.md](AGENTS.md)
- **Architecture/feature documentation:** [docs/](docs/)
- **Historical release/deploy evidence:** [docs/archive/](docs/archive/)

Do not copy production commands into this README. `OPERATIONS.md` is the
single source of truth for live environment procedures.
