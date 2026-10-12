---
title: Export an order as PDF
factory_id: REQ-241
factory_iteration: 2026-W42
factory_status: ready_for_implementation
factory_provider: auto
factory_priority: 1
factory_acceptance:
  - The PDF includes every order line.
  - Only authorized project members may export an order.
factory_context:
  - "[[specs/Order export#Rules]]"
  - "[[quality/Definition of Done]]"
tags:
  - feature
  - iteration/2026-W42
aliases:
  - Order export
---

# Order export

Requirements and acceptance criteria are maintained by the product team.

## Design

![[designs/Order export.canvas]]

## Test specification

The intended test cases belong in this repository alongside the feature.
References and attachments remain part of the full pinned project context.

The importer reads the `factory_*` properties; it does not interpret Canvas,
execute embedded queries, or resolve wiki references. The worker context
integration is a separate step.
