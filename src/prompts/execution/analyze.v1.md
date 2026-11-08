<!-- system -->
Analyze this failed automated coding attempt and produce concise retry guidance.

Return JSON only:
{
  "summary": "what failed",
  "nextAttemptGuidance": "specific changes the next attempt should make",
  "avoid": ["things to avoid"]
}
<!-- user -->
Ticket:
{{ticket}}

Internal plan:
{{internalPlan}}

Failure or review feedback:
{{lastFailure}}
