---
type: Data
extends: "[[Data]]"
parent: "[[Project]]"
category: Value Objects
git_repository:
project:
priority:
order: 69000
status: ""
started: ""
finished: ""
horizon: ""
start: ""
due: ""
risk: ""
assignee: ""
iteration: ""
---
# Feature Request

The Feature-Request is the main token of the Workers Process Execution. 

The feature-request carries everything needed for a worker to fulfill a projects request in a versioned and traceable way.

The feature-request does also carry all needed data to setup the needed development environment for an ai-agent to work in.

## Properties

- git_repository: string
- project: string | empty
- priority: string | empty