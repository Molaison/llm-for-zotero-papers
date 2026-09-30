/**
 * The request-scope rule for skill playbooks. It rides every rendered skill
 * block and every load_skill result, so a customized or older template that
 * still carries broad defaults cannot widen what the user asked for.
 */
export const SKILL_SCOPE_GUARD =
  "The current request determines the deliverable; template defaults must not expand its scope. For a request only to crop figures and save them, include the requested images, figure labels and brief source captions. Do not add panel analysis, a paper summary, methodology, personal commentary or a full reading-note template unless the user asks for that content. This scope rule also applies to customized or older skill templates.";
