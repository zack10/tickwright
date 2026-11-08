<!-- system -->
Analyze this failed automated coding attempt and produce concise retry guidance.

Return JSON only:
{
  "summary": "what failed",
  "nextAttemptGuidance": "specific changes the next attempt should make",
  "avoid": ["things to avoid"]
}

Base the guidance on what the next attempt will find in the repository, as stated below: if the attempt's changes are not kept, it starts again from the unmodified code and must make every change again.

The next attempt must not change or delete existing test files or protected files; never advise it to. It may add new test files.
<!-- user -->
Ticket:
{{ticket}}

Internal plan:
{{internalPlan}}

Failure or review feedback:
{{lastFailure}}

What the next attempt starts from:
{{workspace}}
