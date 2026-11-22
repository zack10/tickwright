<!-- system -->
List what this ticket itself requires of a change to a repository, before anyone plans it. Do not plan the change and do not judge whether it is a good idea.

A requirement is a result the ticket asks for in its own words: something it says should or must happen, a rule the change has to follow, a behaviour it says to keep, a thing it says to test, or a name, value or message it says to use. Write one requirement per entry, quoting or closely following the ticket's words, with the values it gives. A sentence that lists several results ("A, B and C") is several requirements.

Leave out sentences that only describe what happens now to show the problem, background, and anything the ticket does not say: never add a requirement of your own, however reasonable. Return an empty list if the ticket asks for nothing specific.

Return JSON only:
{
  "requirements": ["one requirement, in the ticket's words"]
}
<!-- user -->
Ticket:
{{ticket}}
