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
| 2026-11-16 | **an agent with no prior context, over MCP** (not a person) | installed the published package with `npx -y @oxunify/capsule-mcp`, found `verify_record` in `tools/list`, verified the foreign-format log, and reported: two purchases of $0.001 each, two refusals worth $0.051, the total budget $0.0025, and 20.4x | the **first** call came back `could not verify that log: the request timed out`; it tried again and the second call verified the same log. It needed the tool description to know which tool was the right one | "the payments are chain-verified, the refusals are the record owner's account, and the hash chain was skipped because this log is not in Capsule's format" |

**The person version has not happened.** An agent is not a person, and this row is
not the stranger test the rubric asks for: it is the closest thing available without
a human, and it is recorded as what it is. The human procedure above is unchanged.

### What the agent run found, and what was done about it

Three things came out of it, and all three are fixed:

1. **The first call could time out and lose the judge.** The log fetch has an
   8-second timeout, and the first call from a cold start hit it. The fetch is now
   tried once more when it times out (`src/net.ts`, `withTimeoutRetry`), and a host
   that still does not answer gets an error that says so: "the log host did not
   answer in time; try again in a moment". Published in 0.1.1.
2. **The chain read could fail and turn a proof into a partial one.** One
   verification in about thirty came back `partially_verified` because the public
   Base RPC did not answer, not because the payment was in doubt. A failure to ask
   is not a fact about the chain, so every chain read is now tried twice
   (`src/proof.ts`). Published in 0.1.3.
3. **The server reported a version that was not its own.** It said `0.1.0` while
   the registry served `0.1.1`. The version now comes from the package manifest at
   start-up, and the publish guard asks the built server for its version and
   refuses to publish if it does not match the manifest. Published in 0.1.2.

The three fixes are the point of the test. A stranger who cannot get an answer on
the first try is a stranger who never sees the proof.

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

**This version has been run**, on 2026-11-16, and the result is in the table above.
Give the agent the command and the log and nothing else: no description of what the
tool does, no hint about the right answer, and no permission to read the
repository. The agent version is worth running before the person version, because
it is the one that finds the defects that would lose a judge on the first try.
