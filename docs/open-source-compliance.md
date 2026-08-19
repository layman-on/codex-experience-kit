# Open-source compliance

Codex Experience Kit is released under the MIT License as an independent implementation. Its renderer selector research and explicit loopback-CDP lifecycle were informed by Codex Dream Skin, which is also MIT-licensed. The complete upstream copyright and permission notice must remain in the repository and every distributed npm package through `NOTICE.md`.

## Reused and independent boundaries

- Reused with attribution: a small renderer selector vocabulary and architectural research around explicit loopback CDP, process ownership, persistent injection, and restoration.
- Independently implemented: the TypeScript SDK and CLI, Experience manifest, target/plane placement, iframe sandbox, capability API, appearance-token generator, project compiler, synthetic preview, library, transaction engine, and tests.
- Not included: Dream Skin injector source, theme CSS, presets, screenshots, artwork, application binaries, branding, or logos.

The pinned selector provenance for the initial public release is:

`https://github.com/Fei-Away/Codex-Dream-Skin/blob/6f789be4570b1d5c9e7e60545f22173195968720/tools/selectors.json`

## Release checklist

1. Keep `LICENSE`, `NOTICE.md`, `SECURITY.md`, and this document in the repository and npm `files` allowlist.
2. Keep the selector provenance comment in `src/node/codex-runtime.ts` when selectors are retained or updated.
3. Do not commit `theme-output/`, generated ZIP/TGZ archives, user themes, screenshots, or local reference artwork without a separate rights review.
4. Run `npm run compliance:check`; it inspects `npm pack --dry-run` and rejects packages containing unexpected media or theme output, or missing required legal documents. Continue to inspect credentials, local paths, and application binaries during review.
5. Preserve the independent/unofficial OpenAI disclaimer and do not use OpenAI or Dream Skin logos, trade dress, or claims of endorsement.
6. Review every newly vendored dependency or asset separately; an npm dependency declaration does not grant rights to copy unrelated repository assets.

This is an engineering release policy, not legal advice. Applicable trademark, contract, interoperability, and local-law questions require separate review when distribution scope changes.
