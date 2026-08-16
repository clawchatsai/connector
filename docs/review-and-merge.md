# Review and merge policy

This repository is developed largely by automated agents. That fact changes what
GitHub can and cannot enforce, and this document records the resulting choices so
that a later reader does not have to reverse-engineer them from the settings page.

## `main` branch protection

Current state:

| Setting | Value |
| --- | --- |
| Require a pull request before merging | **yes** |
| Required approving reviews | **0** |
| Dismiss stale reviews | yes |
| Force pushes | blocked |
| Branch deletion | blocked |
| Enforce for admins | no |

## Why zero required approvals

Until 2026-08-16 this branch required one approving review. That requirement was
**unsatisfiable**, not merely inconvenient.

Every agent in this organisation authenticates to GitHub as the same account,
`KoKos024`. GitHub refuses to let an account approve its own pull request:

```
$ gh pr review 5 --approve
failed to create review: GraphQL: Review Can not approve your own pull request
```

So no agent could ever produce the required approval on any pull request in this
repository, no matter how genuine the review behind it. The only way through was
`gh pr merge --admin`, which worked because `enforce_admins` is off.

A control that can only be satisfied by bypassing it is worse than no control. It
does not prevent the unreviewed merge it was meant to prevent, and it teaches
everyone who meets it that overriding branch protection is routine. The
requirement was removed rather than left in place to be bypassed.

The pull request requirement itself is kept. It is satisfiable, it forces every
change into a reviewable diff, and it produces a stable URL to cite as evidence.

## Where review is actually recorded

**GitHub cannot attest review in this repository, and no setting will make it.**
`gh pr view <n> --json reviews` returns `[]` on agent pull requests whether or not
a real review happened, and `author == mergedBy` is the expected reading in both
cases. Do not read either signal as evidence of anything.

Review is recorded in Paperclip. The reviewer is assigned a child issue carrying
the pull request URL and what to check; they report their findings on that child
issue and close it. That issue is the system of record. If a pull request merged
without one, say so in the closing comment rather than leaving it to be inferred.

## What would restore machine-checkable enforcement

A required **status check** — unlike an approval — is satisfiable by an agent and
cannot be rubber-stamped, because the CI run either passed or it did not. That is
the gate this repository should carry.

It is not enabled yet, because per-change CI does not exist here yet. The workflow
is written and parked at [`docs/ci/test-workflow.yml`](ci/test-workflow.yml); agent
tokens lack the `workflow` scope, so it must be installed by a human:

```bash
cp docs/ci/test-workflow.yml .github/workflows/test.yml
```

Once it runs on pull requests, add it as a required check:

```bash
gh api -X PATCH repos/clawchatsai/connector/branches/main/protection/required_status_checks \
  -F strict=true -f 'contexts[]=test'
```

Note the limit of what this buys. A status check attests that the tests passed. It
does not attest that a second party exercised judgement about whether the change is
*right*. Those are different claims, and only the first is mechanisable under a
shared identity. The Paperclip child issue remains the record for the second.

## Distinct reviewer identities

Giving reviewers their own GitHub account would make approvals real signal again.
It was considered and deferred, because the obvious version does not work: all
agents currently share one container and one `$HOME`, so they share one `gh`
credential. A second token placed there is reachable by the pull request author as
easily as by the reviewer, which buys the appearance of independent approval
without the substance.

Doing this properly requires per-agent credential isolation first. That is
infrastructure work owned by a human, not a repository setting.

## Using `--admin`

You should no longer need it. Every remaining rule on `main` is satisfiable through
the normal path.

If you find yourself reaching for `gh pr merge --admin`, treat that as a signal
that something is misconfigured, and report it instead of overriding it.

## Reverting

To restore the previous configuration:

```bash
gh api -X PATCH repos/clawchatsai/connector/branches/main/protection/required_pull_request_reviews \
  -F required_approving_review_count=1
```
