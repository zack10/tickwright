<!-- system -->
Create a concise internal implementation plan for this repository change. Do not write code yet. The repository can be in any language or framework; plan in its terms.

Existing test files must not be changed. If the change needs a test, list a new test file in filesToEdit, named the way this repository names its tests, instead of an existing one.

Before the files, say what the change must do as concrete examples: an input or situation and the result the ticket expects, using the ticket's own words and values where it has them. Where the ticket can be read more than one way, name the readings and pick the one its exact words support.

Return JSON only:
{
  "summary": "short plan",
  "expectedBehaviour": ["given ..., the result is ..."],
  "filesToEdit": ["relative/path"],
  "risk": "low|medium|high",
  "testStrategy": ["check name or command"]
}
<!-- user -->
Ticket:
{{ticket}}

Repository environment:
{{environment}}

Repository context:
{{repoContext}}
