import { tr } from "./i18n";

/** Copy text with Clipboard API when available; fallback for Android / non-HTTPS. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (text === "" && text.length === 0) {
    /* allow empty */
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* execCommand fallback */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "2em";
  ta.style.height = "2em";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  if (!ok) throw new Error("Copy failed");
}

/** Wrap a text field with a hover-reveal copy control in the corner. */
export function wrapFieldWithCopyButton(field: HTMLTextAreaElement | HTMLInputElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "field-copy-wrap";
  wrap.appendChild(field);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "field-copy-btn";
  btn.title = tr("Copy");
  btn.setAttribute("aria-label", tr("Copy"));
  btn.textContent = "⎘";
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      await copyTextToClipboard(field.value);
      btn.classList.add("field-copy-btn--ok");
      btn.textContent = "✓";
      window.setTimeout(() => {
        btn.classList.remove("field-copy-btn--ok");
        btn.textContent = "⎘";
      }, 1400);
    } catch {
      btn.classList.add("field-copy-btn--err");
      window.setTimeout(() => btn.classList.remove("field-copy-btn--err"), 1400);
    }
  });
  wrap.appendChild(btn);
  return wrap;
}
