# hello-bundle — dev probe (not shipped)

Zero-dependency probe bundle that validates the whole `dsh --profile mobile`
integration chain before the real CLI plugin lands:

1. `dsh plugin --profile <name> install` composes a `dsh.bundle.patch`-declaring
   package into the profile bundle stack (reconcile by installed state).
2. Launcher args reach the plugin via the `cmdlineArgs` service.
3. `appExit` terminates the process cleanly.

Verified 2026 on Windows (pnpm 10.12.4, dsh 0.1.0-rc.6):

```
dsh --profile mobile hello world
# HELLO-ARGS ["hello","world"]  (exit 0)
```

## Why the weird install flow exists (Windows)

`dsh plugin --profile <name> add link:<abs-path>` and `file:<abs-path>` are
broken for absolute Windows paths (pnpm mis-parses the drive letter as a URL
host and creates a dangling junction like
`profiles\<name>\D:\deepseek-harness-mobile-solution\...`). The working pattern
(in `scripts/install-mobile.mjs`, upcoming):

1. Create a `vendor-packages` junction inside the profile dir pointing at this
   repo's `packages/` directory (`mklink /J` on Windows, `ln -s` on POSIX).
2. Write the manifest dependency with a RELATIVE spec that travels through the
   junction: `"@bb-84c/<pkg>": "link:./vendor-packages/<dir>/<pkg>"` (no drive
   letter anywhere → pnpm realpaths through the junction correctly).
3. Run `dsh plugin --profile <name> install` → pnpm links the package and the
   official reconcile appends it to `dsh.profile.bundles`.

Because the profile entry is a junction, Node resolves the package's own
imports from its real directory (repo checkout), so the repo root must have
its dependencies installed (`pnpm install` at the repo root) — the packages
find `commander`/`@deepseek-ai/dsh-cmdline` by walking up.
