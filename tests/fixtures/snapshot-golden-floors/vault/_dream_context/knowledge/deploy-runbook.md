---
name: Deploy Runbook
description: Steps to cut a release of the fixture project.
type: knowledge
tags:
  - 'topic:snapshot'
---

Build, run the unit suite, then verify the rendered snapshot is still under the
harness persist limit before tagging.

Anything that changes the snapshot format needs the golden regenerated from the
recorded base SHA, never from the working tree.
