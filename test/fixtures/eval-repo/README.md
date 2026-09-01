# Eval Repo

A tiny synthetic repository used by Loreline's evaluation suite (`test/evals/`)
to check question and context quality against a deterministic, known scan.

It intentionally has almost no documentation beyond this README, so a scan
reports most readiness findings as missing or partial. `secrets-excluded/` is
listed in `loreline.yaml`'s `scan.exclude`, so nothing under it is ever part
of a scan or sent to an AI provider; the evaluation suite writes a planted
fake credential there at test time to verify that boundary holds.
