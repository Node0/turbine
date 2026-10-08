# Turbine roadmap
 
Nearest first. Each item is a direction, not a commitment to a design; the notes record what we already know.
 
---
 
## 1. Keep the preview until the user clears it
 
Fix Turbine so that a preview survives switching views. Today, if the preview pane has output and you flip to the Source view and back, the output is gone. Every preview costs money with a paid provider, or minutes with local inference, so it must not be lost like that. It should stay until the user presses a new **Clear preview** button.
 
Why it happens:
- The preview's output, rendered messages, validation note and token stats are fields on the Prompt page component (`client/pages/prompt/prompt.ts`). Leaving the view disposes the page, and the fields go with it.
- A preview that is **still generating** is cancelled when you leave (`unmounting()` aborts it), so a half-finished paid generation is thrown away too.
Direction:
- Move preview state into a service, alongside the prompt service, so it outlives the page. The page only displays it.
- Let an in-flight preview keep running in the background when you leave. Coming back shows it still streaming, or finished. Only **Stop** or **Clear preview** ends it.
- **Clear preview** empties the output, messages and stats. Running a new preview replaces the old one, as now.
- Open question: should the last preview also survive a page reload (browser storage), or just view switches?
---
 
## 2. Modularize Turbine's use-case-specific capabilities
 
Turbine is a general sliding-window map/reduce tool. Turning a plain-text book into Markdown is one use case among many, but parts of the engine still assume it. Move every use-case and format-specific capability behind a module boundary so the engine stays general.
 
The first step is done: the Markdown cleanup used by the conserve validator lives in `shared/formats/markdown.ts`. Still in the engine:
 
| Where | Markdown assumption |
|---|---|
| `shared/engine/validators.ts` | `conserve` calls `stripMarkdown()` directly |
| `shared/engine/template.ts` | `DEFAULT_SYSTEM_PROMPT` is the book-to-Markdown preset, built in as *the* default |
| `shared/engine/assemble.ts` | failed and pending windows are marked with `<!-- turbine: … -->` HTML comments; filenames default to `.md` |
| `server/routes/jobs.ts`, `server/jobs.ts`, `client/services/job.ts` | output is served and downloaded as `text/markdown` / `.md` |
 
Proposed shape: a **format profile** per module in `shared/formats/` that provides:
- the comparison cleanup for validators
- the file extension and content type
- how to mark a failed or pending window
- optional default prompts
A job names its format, with Markdown as the default so existing jobs behave the same. This adds a field to `JobSpec` and the API.
 
---
 
## 3. Step through the template, window by window
 
Bring more visibility to the variables in the system and task (window template) prompt flows. Add a manual step-through for auditing what the template system hands the pipeline at any window:
 
- Rev forward and back through the planned windows (1 … N), or jump to any window.
- For each window, show the value of every variable: `context_before`, `focus`, `context_after`, `carry`, `window_index`, `window_count`, `source_name`. Also show which conditional branches (`{% if %}` / `{% else-if %}` / `{% else %}`) were taken and why.
- Show the fully rendered system and user messages for that window, exactly as the model would receive them.
Notes:
- `carry` depends on the previous window's *output*. Before a run it is empty or hypothetical; during and after a run it can come from the checkpoint. The view should say which.
- Rendering is already deterministic and shared by preview and run (`buildMessages()`), so the step-through can't disagree with what a job sends.
---
 
## 4. Presets: save a system + task prompt under a name
 
Add the ability to save a system prompt and task prompt together under an editable name, so a working pair can be recalled later instead of being retyped or pasted in.
 
Where it lives:
- A collapsible **Presets** component at the very top of the page, before Instructions.
- It holds an option list of the saved presets. On a first run, with nothing saved, it still shows its (empty) option element.
- Next to the **Presets** title, muted grey text in the same color as the "(System Prompt)" text in the Instructions component, reading: "Save to current preset or create a new preset for persistent task management".
- Two actions: **Save To Current Preset** and **Create New Preset**.
Behavior:
- **First save, empty list.** If no presets exist, either button creates a new preset. This applies only that first time, while the option list is empty.
- **Save To Current Preset, once presets exist.** First check whether a saved preset exists in the list. If so, saving would overwrite it, so open a confirmation dialog whose **Confirm** button is unclickable for a 5-second countdown. The cooldown is a stopgap against system-1 thinking errors overwriting an existing preset. It is the guard until we have robust database integration and can offer a history.
- **Create New Preset.** No guard: nothing is being overwritten, and it is the path for making new presets. It opens a dialog with a naming field, prepopulated with a short 5-word best guess from the selected LLM, if one is configured. If none is configured, it fills in `untitled-preset-<number>`.
- The name stays editable.
Notes:
- The overwrite guard is deliberately temporary. Once presets are in a database with history, an overwrite becomes recoverable and the countdown can be dropped or relaxed.
- Open question: where presets are stored until the database exists (browser storage is the obvious candidate).
- Open question: how this meets item 2. `DEFAULT_SYSTEM_PROMPT` is currently the built-in book-to-Markdown preset, and format profiles may supply optional default prompts. Those could surface here as built-in, read-only presets.
---
 
## 5. Cost modeling for remote providers
 
Bring cost modeling to the remote, model-priced connectors: OpenRouter, OpenAI and Anthropic.
 
- **Projected cost for the whole document**, as loaded on the Source tab, from the window plan and the model's prices.
- **Cost per window.**
- **An accurate running cost**, including in dry-run preview mode, so previews are costed too.
Notes:
- OpenRouter's model list includes per-token prompt and completion prices, so its costs can be discovered the same way model parameters already are. OpenAI and Anthropic don't publish prices through their APIs, so those need a maintained price table with a visible "as of" date.
