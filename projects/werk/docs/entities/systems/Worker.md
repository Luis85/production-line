---
type: System
extends: "[[Base Entity]]"
description:
status:
color:
category:
parent: "[[projects/werk/docs/entities/systems/Orchestrator|Orchestrator]]"
aliases:
tags:
emits:
  - "[[New Pull Request]]"
  - "[[Pull Request Updated]]"
  - "[[Feature Request Updated]]"
  - "[[New Increment Created]]"
  - "[[Increment Updated]]"
subscribes:
  - "[[New Feature Request]]"
  - "[[Feature Request Updated]]"
order: 42125
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
The Werk Worker ingestes and processes incoming feature-requests.

The Werk Worker lives in a configurable folder. In this folder he manages and maintains his projects. 
A project needs to get registered before the worker can execute on it. 
Once a project gets registered, he prepares the project folder by git cloning the projects repository and checking out the shared branch (default main, configurable).
In his folder he manages all projects in their own sub-folder, all worktrees he creates are subfolders inside the corresponding project.

He ingests feature-requests, adds them to his queue and makes them visible on the kanban board and also as saved markdown file in the corresponding project folder. 
He manages and maintains his own git branches for his projects and dispatches ai-agents into prepared project-environments to let them implement a feature-request in isolation.
His goal is to automate the software-development process as much as possible and to make the whole process transparent, traceable, and verifiable.

In order to achieve his goals, the worker has access to git, his file-system, and ai-agents through their cli. 

The worker provides a webview or a cli for interaction. He is also able to pick-up feature-request markdown-files from the shared git branch.
