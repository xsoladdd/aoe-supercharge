---
name: todo
description: Adds a todo to the user's Supercharge todo list for the project you are working in (checkboxes on the whiteboard in the Supercharge office and on its Notes page), or ticks one off. Use when the user types /todo, and when you finish something that is on the project's open todos.
---

# Todo

Add the todo through Supercharge, with its text on standard input:

```bash
supercharge todo add - --json <<'EOF'
<the todo>
EOF
```

- The todo is what the user wrote after `/todo` (ARGUMENTS below). If there is nothing there, ask what to add.
- Start it with a verb and keep it to one line ("Ask Jonas about the gift-card export"). For several things, add one todo each.
- It goes to the project of the folder you are in. If the command says the folder is not in a Supercharge project, run it again with `--global` added and tell the user it went to the global todos.
- Then reply in one line: the todo, where it went, and its id from the JSON.

## Ticking todos off

- `/todo done <id or words>`: find the todo in `supercharge notes --json` (by its id, or the open todo whose text matches the words) and tick it with `supercharge todo done <id>`. If more than one matches, ask which.
- When you finish work that matches an open todo in `supercharge notes --json`, tick it yourself with `supercharge todo done <id>` and say so in your reply.
- `supercharge todo reopen <id>` unticks one. Never archive notes or todos: archiving is the user's.
