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

## 4. Cost modeling for remote providers

Bring cost modeling to the remote, model-priced connectors: OpenRouter, OpenAI and Anthropic.

- **Projected cost for the whole document**, as loaded on the Source tab, from the window plan and the model's prices.
- **Cost per window.**
- **An accurate running cost**, including in dry-run preview mode, so previews are costed too.

Notes:
- OpenRouter's model list includes per-token prompt and completion prices, so its costs can be discovered the same way model parameters already are. OpenAI and Anthropic don't publish prices through their APIs, so those need a maintained price table with a visible "as of" date.
- Projections can use the planner's existing token estimates. Running totals should use the token counts each response reports (already recorded per window as `usage`), not estimates.
- Reasoning tokens, cached-prompt discounts and retries change the real cost. The model should account for them, or at least say when it can't.
