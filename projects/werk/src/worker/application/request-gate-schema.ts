/** Discovery schema; validateGatePolicy remains the authoritative bounded validator. */
export const requestGateSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://werk.local/schemas/request-gates.schema.json",
  "title": "Werk deterministic request gate policy",
  "description": "Rules validate recorded facts. Unknown observations fail closed. Runtime additionally requires unique rule IDs within each stage/kind and a serialized policy at most 64 KiB.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "version",
    "ready",
    "done",
    "reviewer",
    "rework"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "id": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9_-]{1,100}$"
    },
    "version": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "ready": {
      "$ref": "#/$defs/kinds"
    },
    "done": {
      "$ref": "#/$defs/kinds"
    },
    "reviewer": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled",
        "provider",
        "maxAttempts"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "provider": {
          "const": "same"
        },
        "maxAttempts": {
          "const": 1
        }
      }
    },
    "rework": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "maxAttempts"
      ],
      "properties": {
        "maxAttempts": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3
        }
      }
    }
  },
  "$defs": {
    "rule": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "fact",
            "op",
            "value"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[a-zA-Z0-9_-]{1,100}$"
            },
            "fact": {
              "enum": [
                "input.kind",
                "execution.outcome",
                "output.candidateDigest"
              ]
            },
            "op": {
              "enum": [
                "eq",
                "neq"
              ]
            },
            "value": {
              "type": "string",
              "maxLength": 200
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "fact",
            "op",
            "value"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[a-zA-Z0-9_-]{1,100}$"
            },
            "fact": {
              "enum": [
                "input.titleLength",
                "input.messageLength",
                "input.criteriaCount",
                "input.approvedFileCount",
                "input.approvedBytes",
                "output.changedFileCount",
                "output.requiredCheckCount",
                "pending.count",
                "findings.blockingCount"
              ]
            },
            "op": {
              "enum": [
                "eq",
                "neq",
                "gte",
                "lte"
              ]
            },
            "value": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "fact",
            "op",
            "value"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[a-zA-Z0-9_-]{1,100}$"
            },
            "fact": {
              "enum": [
                "input.pathsValid",
                "output.nonEmpty",
                "output.protocolValid",
                "output.patchPresent",
                "output.verificationPassed",
                "output.verificationEligible",
                "operator.accepted",
                "tests.passed",
                "build.passed",
                "execution.recoverySafe"
              ]
            },
            "op": {
              "enum": [
                "eq",
                "neq"
              ]
            },
            "value": {
              "type": "boolean"
            }
          }
        }
      ]
    },
    "kinds": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "chat",
        "patch"
      ],
      "properties": {
        "chat": {
          "type": "array",
          "maxItems": 32,
          "items": {
            "$ref": "#/$defs/rule"
          }
        },
        "patch": {
          "type": "array",
          "maxItems": 32,
          "items": {
            "$ref": "#/$defs/rule"
          }
        }
      }
    }
  }
} as const;
