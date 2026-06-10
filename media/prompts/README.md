# Bundled prompt templates

These files are deployed by the Working Memory extension into a workspace on install/upgrade. The agent file lives under `.github/agents/` (auto-discovered by VS Code, no settings required); instruction stubs live under `.github/prompts/`; `AGENTS.md` sits at the workspace root.

| File | Deploys to | Deploys? | Notes |
|---|---|---|---|
| `working-memory.agent.md` | `.github/agents/` | yes | The Working Memory agent itself. Rotated to `.N.backup` alongside on upgrade. |
| `AGENTS.md` | repo root | yes (stub) | Only written if the workspace has no `AGENTS.md` yet. |
| `user.instructions.md` | `.github/prompts/` | yes (stub) | Only written if missing. User fills in. |
| `soul.instructions.md` | — | **no** | Reference only. Optional personality layer the user may copy in by hand. |
