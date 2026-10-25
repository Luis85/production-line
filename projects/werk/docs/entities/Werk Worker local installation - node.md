---
type: Scenario
extends: "[[Scenario]]"
parent: "[[Scenarios]]"
emits:
subscribes:
  - "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
color:
tags:
aliases:
category:
description:
status:
relations:
actors:
  - "[[AI-Agent]]"
  - "[[System User]]"
  - "[[Worker]]"
---
The Werk Worker has it's own folder in which he can work from.
The user has a running local Werk Worker without docker.
The user has configured his projects.

The user opens the Werk Worker Webview and enters his feature-request.
The worker ingests the request and keeps the user informed during execution.
Once everything is done, the executed work gets presented for review.
Each increment ships with it's quality reports build in the verification pipeline.