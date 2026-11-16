# The stranger test

The one thing this project has not proved. Everything else in the repository is
evidence; this is a procedure, and it needs a person.

## What it is, and what it proves

A judge opens one URL and uses it without help. That is the "user readiness" criterion
the event names, and right now the only person who has used `/verify` is the person who
built it. Nothing in the repository can stand in for that, because "it works" and
"somebody who had never seen it worked" are different claims.

The test is cheap, it takes about half an hour, and it is the user's to run, because it
needs somebody who has not seen this project before.

## Who to pick

Anyone who builds agents and has not seen this repository. A builder from another
hackathon track is ideal. Not the person who wrote the code, and not someone who has
read this file.

## What to send them

Three things, and nothing else. If you have to explain more than this, the test is
already lost.

1. The page: <https://capsule-phi-blond.vercel.app/verify>
2. A log to verify. Their own if they have one; otherwise the worked example in another
   format: <https://capsule-phi-blond.vercel.app/examples/foreign-log.jsonl>
3. The prompt, pasted exactly:

```
Open https://capsule-phi-blond.vercel.app/verify and verify this agent's spending log:
https://capsule-phi-blond.vercel.app/examples/foreign-log.jsonl
Tell me what it bought, what it was refused, what the spending limit cost, and which
parts of that answer are proof and which are somebody's word.
```

That prompt is the whole test. It asks for the four things the product claims to
answer, and the fourth one is the one that matters: an agent that answers "all of it"
has failed the test.

## What to watch

Do not coach. Do not answer a question they could answer by reading the page. Write
down what they do, including the things that went wrong.

| Watch for | A pass looks like | A failure looks like |
| --- | --- | --- |
| They find the input | They paste the URL into the field on the page and press the button | They look for a README, an API key, or a CLI first |
| They read the answer | They read the trace and the record below it | They take the summary and never look at the steps |
| They understand the asymmetry | They say the payments are chain-verified and the refusals are not | They say everything is verified, or nothing is |
| They price the limit | They find "what the limit cost" and say it | They cannot find the number |
| They say what they would do next | "I would check a log before I trust an agent" | "Nice, thanks" |

## The record to keep

Fill this in and put it in the repository. A blank table is a deduction; a filled one
is evidence, even when it is unflattering.

| Date | Who | What they did | What they got wrong | What they said they would do |
| --- | --- | --- | --- | --- |
| | | | | |

## The failures that are worth fixing

If the stranger test fails, the fix is almost never in the verifier. It is almost always
one of these, and all three are cheap:

- They could not tell what to type. The page needs a clearer hint, and the example
  needs to be one click away rather than a URL to copy.
- The answer was too long to read. The summary has to come before the trace, not after.
- The asymmetry was not visible enough. The one line that says what is proof and what
  is somebody's word has to be in the first screen, not in the footer.

## The agent version

If the stranger is an agent rather than a person, the same test runs over MCP. The
package installs with node and nothing else:

```bash
npx -y @oxunify/capsule-mcp
```

Then ask it the same question with `verify_record`:

```
{"log_url": "https://capsule-phi-blond.vercel.app/examples/foreign-log.jsonl"}
```

An agent that runs this and reports "the payments are chain-verified, the refusals are
the record owner's account, and the hash chain was skipped because this log is not in
Capsule's format" has passed. An agent that reports everything as verified has failed.
