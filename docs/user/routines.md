# Routines

A routine is a reusable automation stored at `.proteus/routines/<id>.json` in your project. Each run, called an execution, works in its own worktree and branch, so your checkout stays untouched.

## Create or change a routine

Open **Routines** in the sidebar and choose **New routine**, or type `/routine` in a thread, then describe what you want. Use **Edit** on a routine to change it. Saving an edit means it must be approved again.

## Approve and run

Choose **Review** to see every command, action and the council model, then **Approve**. Approving also adds the routine's executables to the project allowlist. The allowlist matches the program name only, so allowing `node` allows any script it runs. Approval needs the Approve routines permission; if a client lacks it, pair that client again.

Approval lives on your server, so a cloned repo starts unapproved. **Revoke** pauses running executions before their next step.

## Steer an execution

- **Pause** takes effect after the current steps finish.
- **Retry**, **Skip as** and **Restart from** appear when a step fails or an execution needs attention. Restart discards worktree changes made since that step began.
- An execution needs attention when a loop runs out of iterations or stops making progress, or when a merge conflict could not be resolved.
- After a server restart, an execution resumes on its own if **continue threads after update** is on. If a command was running, it waits for you, because that command may still be running.

Executions commit checkpoints to their branch, so these appear in pushes and pull requests.

## Ask a person

A `human` step stops the run and asks you to choose one of its labels, with an optional note. Your choice picks the next step, and later steps can read your note. While it waits, you can only respond or cancel.

## The council

When an agent asks a question, a council agent answers for you and records its reasoning. It never grants approvals or provides secrets.

To answer a step's questions yourself, for example when a skill interviews you about requirements, set `"questions": "person"` on that agent or skill step. The run waits for you in the step's thread, then carries on.

## Finish

A successful execution waits for review. **Mark complete** deletes its worktree and warns you first about uncommitted or unpushed work. Failed executions keep theirs.
