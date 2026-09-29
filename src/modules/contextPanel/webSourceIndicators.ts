import { createSourcePopover } from "./sourcePopover";
import type { WebSourceAnchor } from "../../webAccess/types";
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";
import { t } from "../../utils/i18n";
import { createWebFaviconImage, normalizeWebFaviconUrl } from "./webFavicon";

const ANCHOR_TOKEN_PREFIX = "LLMWEBSOURCEANCHOR";

export type WebSourcePopoverRow = {
  organization: string;
  title: string;
  url: string;
  faviconUrl?: string;
};

function anchorToken(index: number): string {
  return `${ANCHOR_TOKEN_PREFIX}${index}END`;
}

function preserveAnchorParagraphBoundary(markdownAfterAnchor: string): string {
  if (
    !markdownAfterAnchor.startsWith("\n") ||
    markdownAfterAnchor.startsWith("\n\n")
  ) {
    return markdownAfterAnchor;
  }
  const nextLine = markdownAfterAnchor.slice(1).split("\n", 1)[0] || "";
  if (!nextLine.trim() || /^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(nextLine)) {
    return markdownAfterAnchor;
  }
  return `\n${markdownAfterAnchor}`;
}

export function injectWebSourceAnchorTokens(
  markdown: string,
  anchors: readonly WebSourceAnchor[],
): string {
  let result = markdown;
  const sorted = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(
      ({ anchor }) =>
        Number.isInteger(anchor.offset) &&
        anchor.offset >= 0 &&
        anchor.offset <= markdown.length &&
        anchor.sources.length > 0,
    )
    .sort((left, right) => right.anchor.offset - left.anchor.offset);
  for (const { anchor, index } of sorted) {
    result = `${result.slice(0, anchor.offset)}${anchorToken(index)}${preserveAnchorParagraphBoundary(
      result.slice(anchor.offset),
    )}`;
  }
  return result;
}

function launchWebSource(url: string): void {
  const safeUrl = normalizePublicWebUrl(url);
  Zotero.launchURL(safeUrl);
}

export function normalizeWebSourcePopoverRows(
  anchor: WebSourceAnchor,
): WebSourcePopoverRow[] {
  return anchor.sources.flatMap((source) => {
    try {
      const hostname =
        typeof source.hostname === "string" ? source.hostname.trim() : "";
      const organization =
        typeof source.organization === "string" && source.organization.trim()
          ? source.organization.trim().slice(0, 160)
          : hostname.slice(0, 160);
      const title =
        typeof source.title === "string" && source.title.trim()
          ? source.title.trim().slice(0, 500)
          : hostname.slice(0, 500);
      if (!organization || !title) return [];
      const faviconUrl = normalizeWebFaviconUrl(source.faviconUrl);
      return [
        {
          organization,
          title,
          url: normalizePublicWebUrl(source.url),
          ...(faviconUrl ? { faviconUrl } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

function buildSourceIndicator(
  doc: Document,
  anchor: WebSourceAnchor,
): HTMLElement | null {
  const sources = normalizeWebSourcePopoverRows(anchor);
  if (!sources.length) return null;

  const globe = doc.createElement("span");
  globe.className = "llm-web-source-globe";
  globe.setAttribute("aria-hidden", "true");
  return createSourcePopover(doc, {
    label: t("View web sources"),
    icon: globe,
    populate: (popover, close) => {
      for (const source of sources) {
        const row = doc.createElement("button");
        row.type = "button";
        row.className = "llm-web-source-row";
        row.title = `${t("Open web source")}: ${source.title}`;

        const siteIcon = doc.createElement("span");
        siteIcon.className = "llm-web-source-site-icon";
        siteIcon.setAttribute("aria-hidden", "true");
        const favicon = createWebFaviconImage(
          doc,
          source.faviconUrl,
          "llm-web-source-favicon",
        );
        if (favicon) {
          siteIcon.classList.add("llm-web-source-site-icon-has-favicon");
          favicon.addEventListener("error", () => {
            siteIcon.classList.remove("llm-web-source-site-icon-has-favicon");
          });
          siteIcon.appendChild(favicon);
        }

        const content = doc.createElement("span");
        content.className = "llm-web-source-content";

        const organization = doc.createElement("span");
        organization.className = "llm-web-source-organization";
        organization.textContent = source.organization;

        const title = doc.createElement("span");
        title.className = "llm-web-source-title";
        title.textContent = source.title;

        content.append(organization, title);
        row.append(siteIcon, content);
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          launchWebSource(source.url);
          row.blur();
          close();
        });
        popover.appendChild(row);
      }
    },
  });
}

export function decorateWebSourceIndicators(
  root: HTMLElement,
  doc: Document,
  anchors: readonly WebSourceAnchor[],
): void {
  if (!anchors.length) return;
  const tokenPattern = new RegExp(`${ANCHOR_TOKEN_PREFIX}(\\d+)END`, "g");
  const walker = doc.createTreeWalker(root, 4);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || "";
    tokenPattern.lastIndex = 0;
    if (!tokenPattern.test(text)) continue;
    tokenPattern.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(text))) {
      if (match.index > cursor) {
        fragment.appendChild(
          doc.createTextNode(text.slice(cursor, match.index)),
        );
      }
      const anchor = anchors[Number(match[1])];
      const indicator = anchor ? buildSourceIndicator(doc, anchor) : null;
      if (indicator) fragment.appendChild(indicator);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
