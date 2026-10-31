---
status: accepted
---

# Pin new Ticket execution to the submitted source

A fresh Ticket Runtime Attempt uses the latest successfully submitted Change commit for its
configuration and declared Apps, or the approved base before the first submission. The Workspace
keeps its original Source seed and canonical checkout. Reusing the seed for execution would launch
old App commands while independent Review inspects a newer candidate.

The database admits only that exact Change/project revision at create time. Existing Runtime
Attempts remain immutable, including capacity-waiting intents; recovery uses their recorded
revision. A new submission during configuration resolution aborts admission before external
creation rather than silently retargeting it. This does not reset Source, restart a completed Turn
or make a running App automatically adopt changed launch configuration.
