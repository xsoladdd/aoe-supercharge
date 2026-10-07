---
name: gnote
description: Saves a global note, for no project in particular, to the user's Supercharge notes, where the user reads it on the whiteboard in the Supercharge office and on its Notes page. Use when the user types /gnote.
---

# Global note

Save the note through Supercharge, as a global note, with its text on standard input:

```bash
supercharge note add --global - --json <<'EOF'
<the note>
EOF
```

- The note is what the user wrote after `/gnote` (ARGUMENTS below). If there is nothing there, ask what to note.
- Keep the user's words. If you reword it, make it make sense on its own later: one or two plain sentences, no headings or code blocks.
- Then reply in one line: what you noted and its id from the JSON.
