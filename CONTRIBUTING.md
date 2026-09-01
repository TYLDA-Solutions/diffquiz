# Contributing to diffquiz

Thanks for looking at diffquiz. `docs/SPEC.md` is the binding spec for the
CLI's behaviour and module boundaries — if this document and the spec
disagree, the spec wins and this document should be corrected.

## Dev setup

Requires Node >= 22.18.

```
npm ci
npm run check
```

`npm run check` runs the typechecker, the test suite, and a build — it is
the same gate CI runs, so it should pass before you open a PR.

Individually:

```
npm run typecheck   # tsc --noEmit
npm test             # node --test test/
npm run build        # tsc + postbuild
```

## Zero-runtime-dependencies policy

diffquiz ships with **zero runtime dependencies** — Node built-ins only.
This is a product guarantee, not an accident: it's part of what makes the
privacy story ("nothing leaves your machine except to the LLM CLI you
already run") credible. Dev dependencies are limited to `typescript` and
`@types/node`.

**Pull requests that add a runtime dependency will be declined.** If you
think a case genuinely needs one, open an issue first and make the case —
don't spend the PR on it.

## Tests

- Tests run with the native Node test runner: `node --test test/`. Test
  files are TypeScript (`test/<module>.test.ts`), executed via Node's native
  type stripping — no build step needed to run them.
- Every module in `src/` ships its own `test/<module>.test.ts`.
- No network access and no real LLM calls in tests. Provider tests run
  against small fake executables materialised into a temp directory; `git`
  tests build real throwaway repos under `fs.mkdtempSync(os.tmpdir())`.
- Tests must be deterministic, parallel-safe, and clean up their own temp
  directories.
- New behaviour needs a new test. A bug fix should include a regression
  test that fails without the fix.

## Code style

- TypeScript strict mode. No `any` outside the narrowing internals of
  `src/jsonx.ts`.
- No classes except error types (`DiffQuizError`). Prefer plain functions
  and interfaces.
- Comments explain things the code itself can't — a non-obvious constraint,
  a spec requirement, a workaround. Don't narrate what the next line
  obviously does.
- Keep modules within their ownership boundary as described in
  `docs/SPEC.md`'s module map. Shared types belong in `src/types.ts` only.

## Commit style

Short, imperative subject lines ("Add secret scan for JWTs", not "Added" or
"Adding"). Explain the *why* in the body when it isn't obvious from the
diff. Keep unrelated changes out of the same commit.

## Reporting bugs / security issues

Functional bugs: open a GitHub issue with the diffquiz version, OS, Node
version, and a minimal repro if possible.

Security issues: do not open a public issue — see [SECURITY.md](./SECURITY.md).
