# El Toro Application Workspace

Build websites and applications in this repository. Put each application in `apps/<slug>` and keep its setup, scripts, and documentation self-contained.

## Development workflow

1. Inspect the repository and the target application's `package.json` before editing.
2. Use Node.js for JavaScript and TypeScript. Use `pnpm` exclusively for dependencies and package scripts, and commit `pnpm-lock.yaml` changes.
3. Use `rg` for content searches and `fd` for finding files.
4. Run the relevant checks, tests, and production build before publishing. Use the scripts declared by the application rather than inventing parallel commands.
5. Review `git status` and `git diff`, then make a focused commit for a working result. When `origin` is configured, push completed commits to publish them.

The tools are installed system-wide for unattended work. The repository's Nix flake pins the same development toolchain; use `nix develop` when checking the reproducible environment.

## Repository hygiene

Keep credentials in runtime environment variables and provide example environment files containing placeholders. Keep generated dependencies, build output, caches, and local environment files out of Git. Add application-specific guidance in that application's own `AGENTS.md` when its conventions differ.
