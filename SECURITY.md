# Security policy

## Supported versions

Only the latest published release and `main` receive security fixes. Older releases do not.

## Reporting a vulnerability

Report privately through
[GitHub private vulnerability reporting](https://github.com/maxcodefaster/open-software-factory/security/advisories/new).
Do not open a public issue or pull request for a vulnerability.

Include the affected version or commit, the impact and steps to reproduce. Expect an
acknowledgement within a few days. Fixes ship in a new release, and the advisory credits the
reporter unless they ask otherwise.

## Scope

Factory runs Project code in Sandboxes on a Factorybox worker. Reports about escaping a Sandbox,
reading another Project's source or secrets, or bypassing an approval are in scope. Findings that
need an operator to disable the cluster policies the install guide asks for are not.
