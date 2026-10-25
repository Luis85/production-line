---
type: Process
actors:
  - "[[System User]]"
  - "[[Worker]]"
interfaces:
  - "[[Webview Intake Form]]"
  - "[[Command Line]]"
order: 1
inputs:
  - "[[Feature Request]]"
  - "[[Project]]"
  - "[[Git Repository]]"
  - "[[Priority]]"
  - "[[Feature Request Template]]"
outputs: "[[Feature Request]]"
emits:
  - "[[New Feature Request]]"
  - "[[Process Updated]]"
supplier: "[[System User]]"
customers:
  - "[[Worker]]"
  - "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
  - "[[projects/werk/docs/entities/systems/Factory|Factory]]"
  - "[[Webview Kanban Board]]"
  - "[[Worker Queue]]"
  - "[[Git Repository]]"
rules:
  - "[[Feature Request Validation]]"
prev_step: "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
next_step: "[[Pre-Production]]"
status: Open
owner: "[[System]]"
parent: "[[Direct Feature Request to a Worker through the Webview Worker Intake]]"
started: ""
finished: ""
horizon: ""
start: ""
due: ""
risk: ""
priority: ""
assignee: ""
iteration: ""
---
The System provides the [[Webview Intake Form]] for the [[System User]] to input a new [[Feature Request]].

The user inputs a new feature-request. In a drop-down he can choose from the registered projects. This fills out the mandatory git repository and the project string. 

The user can choose one of 3 priorities, default is "3 - low".

The user gives the feature-request a name and describes in the body what he envisions.
Once a project is chosen, he can select one of the projects feature-request-templates or the default one. 
The user can write the body in markdown or a markdown-editor.

On submit the feature-request gets validated and sanitized. 
On success the worker ingests the feature-request and adds it to it's queue.
The feature-request gets written to the workers feature-request folder as markdown file.

The user receives process feedback.
The feature-request appears on the Workers Kanban-Board.

The worker pushes the new feature-request document to the shared branch (default main, configurable).
