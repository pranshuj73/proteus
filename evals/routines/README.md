# Routines

Runs the council prompt and routine author instructions on a real model. Council cases grade the parsed reply; author cases grade the output with the server's routine validator.

## Run

```sh
cd evals
pnpm routines --out runs/routines
pnpm routines --out runs/one --case council-refuses-secret --samples 1
```

It uses your local Claude login. Flags: `--model`, `--samples` (default 3), `--case`. A run writes `results.json` and prints a summary. A full default run is 15 calls on the cheapest model.

Author cases have no tools, so they do not measure the three-repair limit.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, and its expectations.
