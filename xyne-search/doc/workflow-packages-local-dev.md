# Local development for the workflow packages

The workflow engine ships as two packages that this repo consumes from the
registry:

| Package | Used by | Provides |
| --- | --- | --- |
| `@xyne/workflow-sdk` | `server/`, `frontend/` | step/trigger/agent definitions, runtime types |
| `@xyne/workflow-ui` | `frontend/` | the workflow builder UI + styles |

Their source lives in a **separate monorepo, `xyne-spaces`** (under
`packages/workflow-sdk` and `packages/workflow-ui`). To work on those packages
and see your changes in this app **without publishing**, build them locally and
symlink them into `node_modules`.

## Prerequisites

- [bun](https://bun.sh) — the package manager this repo uses.
- A local clone of `xyne-spaces` on the **`deployment`** branch (new code lands
  there regularly):

  ```bash
  git clone ssh://git@ssh.bitbucket.juspay.net/xyne/xyne-spaces.git
  cd xyne-spaces && git checkout deployment
  ```

For the commands below, point two variables at your checkouts:

```bash
export SPACES=/path/to/xyne-spaces   # the monorepo with the packages
export XYNE=/path/to/xyne            # this repo
```

## 1. Build the packages

Each package is built standalone with bun (there is no root workspace install).
The packages expose their `exports` from `dist/`, so they **must** be built
before linking.

```bash
# SDK
cd "$SPACES/packages/workflow-sdk"
bun install
bun run build            # tsc -> dist/

# UI
cd "$SPACES/packages/workflow-ui"
bun install
bun run build            # tsc + tailwind -> dist/ (incl. styles.css)
```

## 2. Symlink into this repo

Replace the installed packages in `node_modules` with symlinks to your local
builds:

```bash
# SDK -> both consumers
for app in server frontend; do
  rm -rf "$XYNE/$app/node_modules/@xyne/workflow-sdk"
  ln -s "$SPACES/packages/workflow-sdk" "$XYNE/$app/node_modules/@xyne/workflow-sdk"
done

# UI -> frontend only
rm -rf "$XYNE/frontend/node_modules/@xyne/workflow-ui"
ln -s "$SPACES/packages/workflow-ui" "$XYNE/frontend/node_modules/@xyne/workflow-ui"

# Make the UI resolve the same local SDK (avoids a second SDK copy / React-style drift)
rm -rf "$SPACES/packages/workflow-ui/node_modules/@xyne/workflow-sdk"
ln -s "$SPACES/packages/workflow-sdk" "$SPACES/packages/workflow-ui/node_modules/@xyne/workflow-sdk"
```

> Tip: save the block above as `link-workflow.sh` — you'll re-run it after any
> `bun install` in this repo (see Gotchas).

Verify the links resolve to your local versions:

```bash
grep '"version"' "$XYNE/server/node_modules/@xyne/workflow-sdk/package.json"
cd "$XYNE/server" && bun -e "import('@xyne/workflow-sdk').then(m => console.log('ok:', Object.keys(m).length, 'exports'))"
```

## 3. Run with live rebuilds

No extra config is needed on the consumer side. `frontend/vite.config.ts`
detects when `@xyne/workflow-*` are symlinked outside the project and
automatically (a) allows Vite to read their real location and (b) dedupes React
so the linked UI shares the app's single React instance. The server's tsconfig
`zodsdk` path alias resolves through the symlink to the SDK's bundled
`zod`, so strict typechecking keeps working.

Run a watcher in each package you're editing so `dist/` rebuilds on save:

```bash
cd "$SPACES/packages/workflow-sdk" && bun run watch    # tsc --watch
cd "$SPACES/packages/workflow-ui"  && bun run watch    # tsc --watch (re-run `bun run build` for CSS changes)
```

Then start the app as usual:

```bash
cd "$XYNE/server"   && bun run dev:v2      # backend on :3000
cd "$XYNE/frontend" && bun run dev         # vite on :5176, HMR picks up the rebuilt dist/
```

## Gotchas

- **Re-link after any `bun install` in this repo.** Installing in `server/` or
  `frontend/` restores the registry version over your symlink — re-run step 2.
- **Keep `xyne-spaces` current.** New code lands on `deployment` regularly:
  `git pull` there and rebuild the changed package (`bun run build`). Re-run
  `bun install` only when its dependencies changed. The symlinks stay valid.
- **Expect API drift.** A local build may be a newer major than the registry
  version this app was written against, so some call sites in `server/` /
  `frontend/` may need updating. That is the package work itself, not a setup
  problem.

## Reverting to the published packages

```bash
cd "$XYNE/server"   && bun install
cd "$XYNE/frontend" && bun install
```

This drops the symlinks and reinstalls the versions pinned in `package.json`.
