from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


W, H = 1280, 920
BG = "#edf1f6"
INK = "#182230"
MUTED = "#657084"
BORDER = "#d7dee8"
SOFT = "#f7f9fc"
ACCENT = "#3e63dd"
GREEN = "#218358"


def font(size: int, bold: bool = False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def text(draw, xy, value, size=16, fill=INK, bold=False, anchor=None):
    draw.text(xy, value, font=font(size, bold), fill=fill, anchor=anchor)


def rounded(draw, box, fill, outline=BORDER, radius=12, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(draw, x, y, label, fill=SOFT, outline=BORDER, color=MUTED, width=None):
    f = font(13)
    left, top, right, bottom = draw.textbbox((0, 0), label, font=f)
    w = width or (right - left + 24)
    rounded(draw, (x, y, x + w, y + 28), fill, outline, 14)
    text(draw, (x + 12, y + 14), label, 13, color, anchor="lm")
    return x + w


def render(kind: str, output: Path):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    rounded(d, (18, 18, W - 18, H - 18), "#ffffff", "#cdd6e1", 18)
    text(d, (42, 42), f"{'A · BEFORE' if kind == 'before' else 'B · AFTER'}  /  LLM FOR ZOTERO UI REVIEW", 13, MUTED, True)

    x0, y0, x1, y1 = 42, 72, W - 42, H - 42
    # Header
    rounded(d, (x0, y0, x1, y0 + 48), "#ffffff" if kind == "after" else "#fbfcfd", BORDER if kind == "after" else "#e4e8ee", 10)
    text(d, (x0 + 14, y0 + 24), "Chat", 13, INK, True, "lm")
    text(d, (x0 + 62, y0 + 24), "Papers", 13, MUTED, False, "lm")
    pill(d, x1 - 168, y0 + 10, "＋  ◷  ···", fill="#ffffff", width=145)
    y = y0 + 60
    if kind == "after":
        rounded(d, (x0, y, x1, y + 56), SOFT, BORDER, 10)
        d.ellipse((x0 + 14, y + 22, x0 + 24, y + 32), fill=ACCENT)
        text(d, (x0 + 36, y + 15), "Paper chat", 11, MUTED, True)
        text(d, (x0 + 36, y + 33), "Protein language models for generative design", 15, INK, True)
        text(d, (x1 - 160, y + 28), "Lin et al. · 2024", 11, MUTED, False, "lm")
        y += 68
    # Timeline
    chat_bottom = H - 242
    rounded(d, (x0, y, x1, chat_bottom), "#ffffff", BORDER, 12)
    cy = y + 28
    user_x = x0 + 180 if kind == "after" else x0 + 120
    rounded(d, (user_x, cy, x1 - 28, cy + 48), "#eef2f6", BORDER, 12)
    text(d, (user_x + 14, cy + 24), "Which claims are supported by the ablation in Figure 2?", 14, INK, False, "lm")
    text(d, (x1 - 28, cy + 63), "You · 10:42", 11, MUTED, False, "ra")
    cy += 96
    text(d, (x0 + 26, cy), "The ablation supports two claims.", 15, INK, True)
    text(d, (x0 + 26, cy + 28), "Removing retrieval reduces grounding; the citation-aware reranker", 14, INK)
    text(d, (x0 + 26, cy + 51), "improves evidence precision. The result is directional evidence.", 14, INK)
    px = x0 + 26
    py = cy + 82
    px = pill(d, px, py, "↗ p. 4", fill="#e9efff", outline="#c6d4ff", color="#3155bf")
    pill(d, px + 6, py, "↗ Fig. 2", fill="#e9efff", outline="#c6d4ff", color="#3155bf")
    text(d, (x0 + 26, py + 42), "Copy    Save note", 11, MUTED)
    cy = py + 66
    rounded(d, (x0 + 20, cy, x1 - 20, cy + 64), SOFT, BORDER, 10)
    text(d, (x0 + 34, cy + 20), "Reviewing 4 papers", 12, INK, True, "lm")
    text(d, (x1 - 34, cy + 20), "Complete", 11, GREEN, True, "rm")
    text(d, (x0 + 34, cy + 43), "Evidence checked · 4 papers · 12 citations", 11, MUTED, False, "lm")
    # Composer
    y = chat_bottom + 12
    if kind == "after":
        rounded(d, (x0, y, x1, y + 34), "#ffffff", "#ffffff", 8)
        px = x0
        px = pill(d, px, y + 3, "Agent mode", fill="#f7f9fc", outline=BORDER, color=INK)
        px = pill(d, px + 6, y + 3, "＋ Add context", fill="#f7f9fc", outline=BORDER, color=INK)
        pill(d, px + 6, y + 3, "Selected text", fill="#f7f9fc", outline=BORDER, color=MUTED)
        y += 42
    rounded(d, (x0, y, x1, H - 42), "#ffffff", "#c5cfdb" if kind == "after" else "#e4e8ee", 12)
    text(d, (x0 + 16, y + 18), "Ask about this paper…", 14, "#8b95a4")
    d.line((x0 + 12, y + 54, x1 - 12, y + 54), fill=BORDER, width=1)
    if kind == "before":
        pill(d, x0 + 12, y + 65, "＋", width=42)
        pill(d, x0 + 62, y + 65, "Select text", width=102)
        pill(d, x0 + 170, y + 65, "Screenshot", width=102)
        text(d, (x1 - 112, y + 79), "Ready", 11, MUTED, False, "rm")
        rounded(d, (x1 - 86, y + 63, x1 - 12, y + 94), ACCENT, ACCENT, 7)
        text(d, (x1 - 49, y + 78), "Send", 12, "#ffffff", True, "mm")
    else:
        pill(d, x0 + 12, y + 65, "Select text", width=102)
        pill(d, x0 + 120, y + 65, "Screenshot", width=102)
        pill(d, x1 - 292, y + 65, "GPT-6 · Balanced", width=140)
        text(d, (x1 - 138, y + 79), "Ready", 11, MUTED, False, "rm")
        rounded(d, (x1 - 86, y + 63, x1 - 12, y + 94), ACCENT, ACCENT, 7)
        text(d, (x1 - 49, y + 78), "Send", 12, "#ffffff", True, "mm")
    im.save(output)


def render_preferences(output: Path):
    im = Image.new("RGB", (1280, 820), BG)
    d = ImageDraw.Draw(im)
    rounded(d, (18, 18, 1262, 802), "#ffffff", "#cdd6e1", 18)
    text(d, (44, 44), "FINAL · PREFERENCES", 13, MUTED, True)
    text(d, (44, 78), "Configure the research workspace", 24, INK, True)
    text(d, (44, 112), "Connections, chat behavior, agent permissions, PDF context, and diagnostics.", 13, MUTED)
    tabs = ["Connections", "Chat experience", "Agent & permissions", "PDF & context", "Usage & diagnostics"]
    x = 44
    for i, label in enumerate(tabs):
        width = 210 if i < 4 else 240
        rounded(d, (x, 152, x + width, 198), "#f7f9fc" if i else "#ffffff", BORDER, 8)
        text(d, (x + width / 2, 175), label, 12, INK if i == 0 else MUTED, i == 0, "mm")
        x += width + 6
    rounded(d, (44, 222, 1236, 764), "#ffffff", BORDER, 12)
    text(d, (70, 258), "Connections", 18, INK, True)
    text(d, (70, 286), "Connect the model providers and web runtimes you use for research.", 12, MUTED)
    for i, (title, status, body) in enumerate([
        ("OpenAI-compatible", "Connected", "GPT-6 · default model"),
        ("Anthropic", "Needs setup", "Add a key to enable Claude Code"),
        ("Web search", "Connected", "Sources are available for literature discovery"),
    ]):
        y = 330 + i * 122
        rounded(d, (70, y, 1210, y + 96), "#f7f9fc", BORDER, 10)
        text(d, (92, y + 28), title, 14, INK, True, "lm")
        text(d, (92, y + 58), body, 12, MUTED, False, "lm")
        text(d, (1178, y + 28), status, 11, GREEN if status == "Connected" else "#ab6400", True, "rm")
    im.save(output)


def render_standalone(output: Path):
    im = Image.new("RGB", (1280, 820), BG)
    d = ImageDraw.Draw(im)
    rounded(d, (18, 18, 1262, 802), "#ffffff", "#cdd6e1", 18)
    rounded(d, (38, 38, 330, 782), "#f7f9fc", BORDER, 12)
    text(d, (66, 70), "LLM for Zotero", 18, INK, True)
    pill(d, 58, 102, "＋  New chat", fill="#ffffff", outline=BORDER, color=INK, width=132)
    pill(d, 58, 140, "⌕  Search history", fill="#ffffff", outline=BORDER, color=MUTED, width=176)
    text(d, (66, 208), "WORKSPACE", 11, MUTED, True)
    for y, label, active in [(238, "▣  History", True), (280, "✦  Skills", False), (322, "⚙  Preferences", False)]:
        rounded(d, (58, y - 18, 310, y + 18), "#e9efff" if active else "#f7f9fc", "#c6d4ff" if active else "#f7f9fc", 7)
        text(d, (74, y), label, 13, INK if active else MUTED, active, "lm")
    text(d, (66, 390), "HISTORY", 11, MUTED, True)
    for i, label in enumerate(["Ablation evidence review", "Compare retrieval methods", "Summarize this paper"]):
        y = 430 + i * 58
        text(d, (74, y), label, 13, INK if i == 0 else MUTED, i == 0, "lm")
        text(d, (74, y + 20), "Today · Paper chat", 10, MUTED, False, "lm")
    rounded(d, (354, 38, 1242, 782), "#ffffff", BORDER, 12)
    text(d, (388, 78), "Ablation evidence review", 20, INK, True)
    text(d, (388, 108), "Paper chat · Protein language models for generative design", 12, MUTED)
    d.line((388, 134, 1206, 134), fill=BORDER, width=1)
    text(d, (388, 182), "The answer is grounded in Figure 2 and page 4.", 15, INK)
    pill(d, 388, 212, "↗ p. 4", fill="#e9efff", outline="#c6d4ff", color="#3155bf")
    pill(d, 474, 212, "↗ Fig. 2", fill="#e9efff", outline="#c6d4ff", color="#3155bf")
    text(d, (388, 284), "Ask a follow-up or switch to another paper from History.", 13, MUTED)
    im.save(output)


if __name__ == "__main__":
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts")
    out_dir.mkdir(parents=True, exist_ok=True)
    render("before", out_dir / "round1-before.png")
    render("after", out_dir / "round1-after.png")
    render_preferences(out_dir / "final-preferences.png")
    render_standalone(out_dir / "final-standalone.png")
