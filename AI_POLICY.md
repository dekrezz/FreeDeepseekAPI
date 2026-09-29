# AI Usage Policy

FreeDeepseekAPI welcomes AI-assisted contributions. We only ask for a few things:

- **Disclose AI usage.** In the pull request or issue, name the tool and the
  model you used, and roughly how much of the work it did. For example:

  ```
  Used Claude Code with Claude Opus 5.5. It wrote the first draft of the fix
  and most of the tests; I reviewed and edited all of it.
  ```

  Other examples: "Used Cursor with GPT-5", "Used Codex CLI", "Used ChatGPT to
  translate the Russian README". If you did not use AI, you do not need to
  write anything.

- **Understand the code you submit.** You should be able to explain what your
  change does and how it interacts with the rest of the proxy without the help
  of an AI tool. When a reviewer asks "why is it done this way?", answer in
  your own words.

- **Check the work before you send it.** Run `npm test`, try the change against
  a real client if it touches requests or streaming, and read the diff
  yourself. You are responsible for the code, not the AI.

- **Issues and discussions can use AI, but a human edits them.** AI is good at
  being verbose and adding noise that hides the main point. Trim the text down
  to what happened, what you expected, and the logs that show it. Include the
  real log output, not an AI summary of it.

Pull requests that clearly were not read or tested by their author may be
closed without a detailed review. You are welcome to open a new one after you
have checked it.

These rules apply to outside contributions. Maintainers use AI tools too and
follow the same idea: a human reviews every change and answers for it.

## There Are Humans Here

Every issue, discussion, and pull request is read and reviewed by people. It is
the place where contributors and maintainers meet, and low-effort, unchecked
work at that point moves the burden of checking it onto the maintainer.

## Why

The cost is lopsided. Generating a pull request takes five minutes. Reviewing
it takes hours of a maintainer's attention. If the author does not understand
the code, a reviewer's "why is it done this way?" gets answered with pasted AI
output, and the maintainer ends up talking to a model through a middleman and
writing the fix themselves, only slower. When such pull requests arrive in
batches, there is no time left for real work, including your bug.

So the rule is not "you used AI, go away". It is "do not hand us the checking
you did not do yourself". This matters most in the fragile parts of the proxy:
session reuse, account failover, streaming, and DeepSeek's undocumented wire
format. A blindly generated patch there can fix your case and break someone
else's.

## AI Is Welcome Here

FreeDeepseekAPI is written with plenty of AI assistance, and we welcome AI as a
tool. This policy is not anti-AI. It exists so that review time goes to
changes someone has actually checked. The tool is not the problem; unchecked
output is.
