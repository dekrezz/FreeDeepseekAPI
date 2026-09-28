# AI Usage Policy

FreeDeepseekAPI is built with AI assistance, and AI-assisted contributions are welcome. The rules are short:

- **Say which AI you used.** In the pull request or issue, name the tool and the model (for example, Claude Code with Claude Opus, Cursor with GPT, Codex), and roughly how much of the work it did.

- **Understand what you submit.** You should be able to explain what your change does and how it fits into the rest of the proxy without asking the AI. If a reviewer asks a question, answer it yourself.

- **You are responsible for the code, not the AI.** Run the tests, check the result, and trim the noise. AI tends to be verbose; issues and pull requests are easier to review when a human has edited them down to the point.

Example line for a pull request:

```
AI: Claude Code (Claude Opus). It wrote most of the tests and the first draft of the fix; I reviewed and adjusted all of it and understand the change.
```

## Maintainers

Maintainers use AI tools too, under the same idea: a human reviews every change and answers for it.

## Why

The cost is lopsided. Generating a pull request takes five minutes. Reviewing it takes hours of a maintainer's attention. If the author does not understand the code, a reviewer's "why is it done this way?" gets answered with pasted AI output, and the maintainer ends up talking to a model through a middleman and writing the fix themselves, only slower. When such pull requests arrive in batches, there is no time left for real work, including your bug.

So the rule is not "you used AI, go away". It is "do not hand us the checking you did not do yourself". This matters most in the fragile parts of the proxy: session reuse, account failover, streaming, and DeepSeek's undocumented wire format. A blindly generated patch there can fix your case and break someone else's.
