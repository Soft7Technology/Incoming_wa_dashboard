# Development and production branches

`dev` contains automated tests, Postman collections and development demonstration pages.
`main` contains the API, workers, migrations, production Facebook pages, deployment tools
and API documentation. `production-files.json` lists the development files excluded from main.
Uploads, environment files, build output and local scratch files are ignored on both branches.
Uploaded data must use persistent storage; removing it from Git does not delete local files.
These rules do not erase files from existing Git history or reduce old clones.

Use a separate checkout for releases so the dev tools remain available:

```sh
git worktree add ../console-api-main main
cd ../console-api-main
```

For subsequent releases, merge dev into this checkout without committing yet:

```sh
git merge --no-commit --no-ff dev
node scripts/prepare-production.cjs --allow-dirty
pnpm install --frozen-lockfile
pnpm run build
git add -A
npm run check:production
git diff --cached --stat
git commit
```

Git may report modify/delete conflicts when dev changes tests already removed from main.
The preparation command removes those development files again and stages the production
configuration. Resolve any remaining application-code conflicts before building or committing.
`--allow-dirty` is specifically for this pending merge; run it only in the release checkout.
Without this option the command refuses uncommitted changes. It runs only on main and never
pushes, builds an image or deploys. Review its staged changes before committing.

The main-only ignore rules keep copied test tools out of subsequent commits. The CI check
also rejects tracked tests, Postman collections, runtime uploads, environment secrets and
scratch files, and checks that the login test route is disconnected and migrations use compiled JavaScript.
Run `npm run check:production` after staging new release files; the check examines the index.

Build production images from main using `docker build --target production -t YOUR_IMAGE .`.
Docker excludes local artifacts, uses the frozen pnpm lockfile and ships compiled application
code with production dependencies. The build first clears dist to prevent stale test assets.
The Node 22 base image and pnpm version are pinned. Update the image digest deliberately
when applying runtime patches; Node must also satisfy the installed PDF parser's engine requirements.
Production migration commands use the compiled Knex configuration; build before running them.
Runtime configuration comes from deployment environment variables or mounted secrets.
