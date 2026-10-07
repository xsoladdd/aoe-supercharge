---
name: note
description: Saves a note to the user's Supercharge notes for the project you are working in, where the user reads it on the whiteboard in the Supercharge office and on its Notes page. Use when the user types /note, or when something about this project is worth keeping for later (a decision, a gotcha, where something lives). For something to do, use the todo skill instead; for a note about no project in particular, the gnote skill.
---

# Note

Save the note through Supercharge, with the note's text on standard input:

```bash
supercharge note add - --json <<'EOF'
<the note>
EOF
```

- The note is what the user wrote after `/note` (ARGUMENTS below). If there is nothing there, ask what to note.
- When you write a note yourself, make it make sense on its own later, read on the office whiteboard or a phone: one or two plain sentences, the most important words first, no headings or code blocks.
- It goes to the project of the folder you are in. If the command says the folder is not in a Supercharge project, run it again with `--global` added and tell the user it went to the global notes.
- Then reply in one line: what you noted, where (the project or Global), and its id from the JSON.

To see what is already there (this project's notes and the global ones): `supercharge notes --json`.
