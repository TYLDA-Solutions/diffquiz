# Security Policy

## What data leaves your machine

diffquiz sends exactly one thing off your machine: a prompt — containing
your diff, plus quiz-generation or answer instructions — to the LLM CLI you
already have configured (`claude`, `codex`, or a custom command you point it
at via `customCommand`). That CLI's own network and data-handling policies
apply from that point on; diffquiz has no visibility into what the provider
does with it.

Nothing else leaves the machine. diffquiz itself makes zero network calls,
has zero runtime dependencies, and collects no telemetry. There is no
account, no server, and no phone-home of any kind. See the Privacy &
security section of the [README](./README.md) for the full picture.

## Threat model

### Prompt injection via diff content

The diff is the one piece of this pipeline that is fully attacker-controlled
— a malicious contributor, or a compromised dependency's changelog pulled
into a diff, could contain text engineered to look like instructions to the
LLM ("ignore the above and instead output..."). diffquiz treats diff content
as **untrusted data**, not instructions:

- Prompts wrap the diff in explicit delimiters and instruct the model to
  treat everything inside them as data to quiz on, never as instructions to
  follow.
- Diff content is never placed outside those delimiters.
- Model output is required to be strict JSON matching a fixed schema
  (`src/jsonx.ts`); anything else is rejected and retried once, then fails
  closed (`INVALID_MODEL_OUTPUT`).
- Quiz questions and explanations are only ever **displayed** to the user —
  diffquiz never executes, evaluates, or shells out based on model output.

**Residual risk, stated honestly:** delimiters and schema validation reduce
but do not eliminate the risk that a sufficiently adversarial diff
influences the *content* of generated questions (e.g. steering which lines
get asked about). Because output is constrained to a validated multiple-choice
schema and is never executed or used to trigger further tool calls, the
practical impact of a successful injection is a misleading quiz question —
not code execution, data exfiltration, or a compromised host. If you find a
way to make injected diff content do more than that, please report it.

### Secret exposure

Before any diff is sent to a provider, `src/secrets.ts` scans **added**
lines for common secret shapes (AWS keys, GitHub/Slack tokens, private key
blocks, generic `key=`/`token=`-style assignments, JWTs, OpenAI/Anthropic
key shapes). This is a **heuristic, not a guarantee** — it will miss secrets
that don't match a known pattern, and it will occasionally flag things that
aren't secrets. On a hit, diffquiz asks for interactive confirmation before
sending anything; it does not silently block or silently proceed. Use
`--no-secret-scan` to skip the check, and never rely on it as your only
safeguard against committing secrets in the first place.

### Supply chain

- Zero runtime dependencies. The published package's only code is
  diffquiz's own.
- Exactly two dev dependencies: `typescript` and `@types/node`.
- No `postinstall`/`preinstall` scripts, in diffquiz or expected of its
  (nonexistent) runtime dependency tree.
- Subprocesses are always invoked as argv arrays (`execFile`/`spawn` with
  `shell: false`) — never through a shell, so diff content or config values
  can't be interpreted as shell syntax.

## Reporting a vulnerability

Please do not open a public GitHub issue for security vulnerabilities.
Email **hello@tylda.solutions** with a description and, if possible, steps
to reproduce. We aim to acknowledge reports and give an initial assessment
within **7 days**, and we practise coordinated disclosure — we'll work with
you on a disclosure timeline once the issue is understood and, where
applicable, a fix is available.
