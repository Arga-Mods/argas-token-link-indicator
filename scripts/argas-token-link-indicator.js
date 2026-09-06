const MODULE_ID = "argas-token-link-indicator";
const INDICATOR_SELECTOR = ".argas-tli-indicator";

// Marks a replayed click that already passed the assign confirmation dialog.
const ASSIGN_CONFIRMED_FLAG = "argasTliAssignConfirmed";

// Preserve the concrete scene-token context for an open Actor sheet, even after
// that token is switched from unlinked to linked and Foundry begins exposing the
// base Actor to the sheet. Only positive token associations are stored here -
// never a prototype fallback - and entries are cleared when a sheet closes,
// because Foundry reuses the same Application instance every time an Actor's
// sheet is opened.
const SHEET_CONTEXTS = new WeakMap();

Hooks.once("init", () => {
  registerSettings();
  console.info(`${MODULE_ID} | Initialised`);
});

// ApplicationV1 Actor sheets used by many systems, including legacy/custom sheets.
Hooks.on("renderActorSheet", (application, html) => {
  scheduleSheetIndicator(application, toHTMLElement(html));
});

// Generic V1 fallback for systems whose sheet class does not dispatch renderActorSheet.
Hooks.on("renderApplicationV1", (application, html) => {
  if (!getActorFromApplication(application)) return;
  scheduleSheetIndicator(application, toHTMLElement(html));
});

// ApplicationV2 support for modern Foundry and system sheets.
Hooks.on("renderApplicationV2", (application, element) => {
  if (!getActorFromApplication(application)) return;
  scheduleSheetIndicator(application, toHTMLElement(element));
});

// Actors-sidebar indicator. Directory entries always target the prototype token.
Hooks.on("renderActorDirectory", (application, html) => {
  if (!getSetting("showDirectoryIndicator", true)) return;

  const root = toHTMLElement(html);
  if (!root) return;

  injectDirectoryIndicators(root);
});

// Token HUD indicator. This is independent of the active game system.
// Visible to Gamemasters only.
Hooks.on("renderTokenHUD", (application, html, data) => {
  if (!globalThis.game?.user?.isGM) return;
  if (!getSetting("showHudIndicator", true)) return;

  const root = toHTMLElement(html);
  const token = getTokenFromHud(application, data);
  if (!root || !token) return;

  injectHudIndicator(root, token);
});

// Foundry renders setting hints via innerText: \n in the language file
// becomes a real line break, but markup inside the text is impossible.
// Decorate the lead-in of each click-hint line afterwards instead.
Hooks.on("renderSettingsConfig", (application, element) => {
  decorateSettingHints(toHTMLElement(element));
});

// Foundry labels the save button of both token configuration windows with the
// same text, and "Assign Token" overwrites the prototype without asking.
// Optionally add explanatory second lines and guard the overwrite.
Hooks.on("renderTokenConfig", (application, element) => {
  decorateConfigButtons(toHTMLElement(element), false);
});

Hooks.on("renderPrototypeTokenConfig", (application, element) => {
  decorateConfigButtons(toHTMLElement(element), true);
});

// Each opening of a sheet must decide its target afresh; Foundry reuses the
// same Application instance across close/reopen cycles.
Hooks.on("closeActorSheet", (application) => SHEET_CONTEXTS.delete(application));
Hooks.on("closeApplication", (application) => SHEET_CONTEXTS.delete(application));
Hooks.on("closeApplicationV2", (application) => SHEET_CONTEXTS.delete(application));

// Keep already-visible indicators current when token or prototype-token data changes.
Hooks.on("updateToken", () => refreshVisibleIndicators());
Hooks.on("updateActor", () => refreshVisibleIndicators());
Hooks.on("controlToken", () => refreshVisibleIndicators());
Hooks.on("canvasReady", () => refreshVisibleIndicators());

// A token switched to "linked" loses its ActorDelta (ActorDeltaField
// initialises to null for linked tokens). Any sheet still open for the
// former synthetic token actor can then no longer save: Foundry's database
// layer reads parent.delta.id while building the request and throws.
// Replace such sheets with the base Actor's sheet, no matter where the
// switch came from (this module, token configuration, another client).
Hooks.on("updateToken", (tokenDocument, changed) => {
  if (changed && "actorLink" in changed) {
    migrateStaleSyntheticSheets(tokenDocument);
  }
});

function registerSettings() {
  game.settings.register(MODULE_ID, "showSheetIndicator", {
    name: "ARGAS_TLI.Settings.ShowSheet.Name",
    hint: "ARGAS_TLI.Settings.ShowSheet.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "showHudIndicator", {
    name: "ARGAS_TLI.Settings.ShowHud.Name",
    hint: "ARGAS_TLI.Settings.ShowHud.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "showDirectoryIndicator", {
    name: "ARGAS_TLI.Settings.ShowDirectory.Name",
    hint: "ARGAS_TLI.Settings.ShowDirectory.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  // No reload required: takes effect the next time such a window renders.
  game.settings.register(MODULE_ID, "clarifyConfigButtons", {
    name: "ARGAS_TLI.Settings.ClarifyButtons.Name",
    hint: "ARGAS_TLI.Settings.ClarifyButtons.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
}

function getSetting(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_error) {
    return fallback;
  }
}

function decorateSettingHints(root) {
  if (!root) return;

  const inputs = root.querySelectorAll(
    `[name^="${MODULE_ID}."]`
  );

  for (const input of inputs) {
    const group = input.closest?.(".form-group");
    if (!group) continue;

    // Other modules prepend their own icons into the setting's label. Foundry
    // grants the label only a narrow share of the row, so a long title and
    // those icons end up on separate lines (widened again in the CSS).
    group.classList.add("argas-tli-setting");

    const hint = group.querySelector?.("p.hint");
    if (!hint) continue;

    for (const node of [...hint.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;

      // Only lines of their own get a lead-in, never the first sentence.
      // Also keeps repeated runs from re-matching already decorated lines.
      if (
        !(node.previousSibling instanceof HTMLBRElement)
      ) {
        continue;
      }

      const match = node.textContent.match(
        /^(\S[^:]{0,23}:)\s*(.*)$/
      );

      if (!match) continue;

      const lead =
      document.createElement("span");

      // Inline so the decoration cannot be lost to a cached stylesheet.
      lead.style.textDecoration = "underline";
      lead.style.textUnderlineOffset = "2px";

      lead.textContent = match[1];
      node.replaceWith(lead, ` ${match[2]}`);
    }
  }
}

function decorateConfigButtons(root, isPrototype) {
  if (!root) return;
  if (!getSetting("clarifyConfigButtons", true)) return;

  const footer = root.querySelector("footer.form-footer");
  if (!footer) return;

  // Equal button heights per row (see CSS), so a longer explanation on one
  // button does not leave its neighbour visibly shorter.
  footer.classList.add("argas-tli-config-footer");

  annotateConfigButton(
    footer.querySelector('button[type="submit"]'),
    isPrototype
    ? "ARGAS_TLI.Buttons.PrototypeSave"
    : "ARGAS_TLI.Buttons.SceneSave"
  );

  const assign = footer.querySelector(
    'button[data-action="assignToken"]'
  );

  annotateConfigButton(
    assign,
    "ARGAS_TLI.Buttons.PrototypeAssign"
  );

  guardAssignButton(assign);
}

// Add the explanation as a smaller line of its own below the button's icon and
// core label, which both stay untouched on the line above.
function annotateConfigButton(button, key) {
  if (!button) return;
  if (button.querySelector(".argas-tli-button-note")) return;

  const note = document.createElement("span");
  note.classList.add("argas-tli-button-note");
  note.textContent = localize(key);

  button.append(note);
  button.classList.add("argas-tli-two-line-button");
}

// Ask for confirmation before "Assign Token" replaces the prototype. The core
// handler is delegated on the application root, so a capture listener on the
// button itself runs first and can hold the click back until the dialog is
// answered; a confirmed click is replayed with a marker this listener lets
// through.
function guardAssignButton(button) {
  if (!button) return;
  if (button.dataset.argasTliAssignGuard === "true") return;

  button.dataset.argasTliAssignGuard = "true";

  button.addEventListener(
    "click",
    (event) => {
      if (event[ASSIGN_CONFIRMED_FLAG]) return;
      if (!getSetting("clarifyConfigButtons", true)) return;

      // Without exactly one controlled token the core handler only shows its
      // own warning; that needs no confirmation.
      const controlled =
      globalThis.canvas?.ready
      ? globalThis.canvas.tokens?.controlled ?? []
      : [];

      if (controlled.length !== 1) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      void confirmAssignOverwrite(button);
    },
    { capture: true }
  );
}

async function confirmAssignOverwrite(button) {
  const DialogV2 =
  globalThis.foundry?.applications?.api?.DialogV2;

  // DialogV2 keeps the focus on "no", so a plain Enter cancels.
  if (DialogV2?.confirm) {
    const confirmed = await DialogV2.confirm({
      window: {
        title: "ARGAS_TLI.Confirm.AssignTitle",
        icon: "fa-solid fa-triangle-exclamation"
      },
      content:
      `<p><strong class="argas-tli-warning">` +
      `${localize("ARGAS_TLI.Confirm.AssignLead")}</strong> ` +
      `${localize("ARGAS_TLI.Confirm.AssignBody")}</p>`,
      yes: {
        label: "ARGAS_TLI.Confirm.AssignYes"
      },
      no: {
        label: "ARGAS_TLI.Confirm.AssignNo"
      },
      modal: true
    });

    if (confirmed !== true) return;
  }

  const replay = new MouseEvent("click", {
    bubbles: true,
    cancelable: true
  });

  replay[ASSIGN_CONFIRMED_FLAG] = true;
  button.dispatchEvent(replay);
}

function scheduleSheetIndicator(application, renderedElement) {
  if (!getSetting("showSheetIndicator", true)) return;

  // The generic render hooks receive inner HTML. Depending on the Application
  // generation, the outer window header can become available slightly later.
  const attempt = () => injectSheetIndicator(application, renderedElement);
  attempt();
  queueMicrotask(attempt);
  requestAnimationFrame(attempt);
}

function injectSheetIndicator(application, renderedElement) {
  const actor = getActorFromApplication(application);
  if (!actor) return;

  const windowElement = getApplicationWindow(application, renderedElement);
  const header = windowElement?.querySelector?.(".window-header");
  if (!header) return;

  const context = getSheetLinkContext(application, actor);
  if (!context) return;

  // Once an open sheet has been associated with a concrete token, retain that
  // association while it stays open. This prevents the indicator from
  // unexpectedly changing to the Actor prototype after linking the token.
  // A prototype resolution is only ever a fallback, so it is not cached -
  // otherwise it would freeze the sheet on "prototype" for good (Foundry
  // reuses the same Application instance across close/reopen cycles).
  if (context.kind === "token") {
    SHEET_CONTEXTS.set(application, {
      kind: context.kind,
      uuid: context.uuid
    });
  } else {
    SHEET_CONTEXTS.delete(application);
  }

  const onLightHeader = isLightBackground(header);

  const existing = header.querySelector(INDICATOR_SELECTOR);
  if (existing) {
    existing.classList.toggle(
      "argas-tli-on-light",
      onLightHeader
    );

    applyIndicatorState(existing, context);
    return;
  }

  const indicator = document.createElement("span");
  indicator.classList.add(
    "argas-tli-indicator",
    "argas-tli-sheet-indicator"
  );

  indicator.classList.toggle(
    "argas-tli-on-light",
    onLightHeader
  );

  const title = header.querySelector(".window-title");

  if (title) {
    title.insertAdjacentElement("afterend", indicator);
  } else {
    header.prepend(indicator);
  }

  prepareInteractiveIndicator(indicator);
  applyIndicatorState(indicator, context);
}

// Whether the element sits on a light background. Walks up to the first
// ancestor with an opaque background colour; a sheet header's brightness is
// decided by the system's sheet design, not by Foundry's colour scheme
// (dnd5e renders beige headers even in Foundry's dark mode).
function isLightBackground(element) {
  let current = element;

  while (current instanceof HTMLElement) {
    const background =
    globalThis.getComputedStyle(current)
    .backgroundColor;

    const match = background?.match(
      /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/
    );

    if (match) {
      const alpha =
      match[4] === undefined
      ? 1
      : Number(match[4]);

      if (alpha > 0.5) {
        const luminance =
        0.2126 * Number(match[1]) +
        0.7152 * Number(match[2]) +
        0.0722 * Number(match[3]);

        return luminance > 127;
      }
    }

    current = current.parentElement;
  }

  return false;
}

function injectHudIndicator(root, token) {
  const existing = root.querySelector(INDICATOR_SELECTOR);
  const context = getTokenLinkContext(token);

  if (existing) {
    applyIndicatorState(existing, context);
    return;
  }

  const indicator = document.createElement("div");
  indicator.classList.add(
    "control-icon",
    "argas-tli-indicator",
    "argas-tli-hud-indicator"
  );

  const rightColumn =
  root.querySelector(".col.right") ??
  root.querySelector(".right");

  (rightColumn ?? root).prepend(indicator);

  prepareInteractiveIndicator(indicator);
  applyIndicatorState(indicator, context);
}

function injectDirectoryIndicators(root) {
  const entries = root.querySelectorAll(
    "li.directory-item[data-entry-id]"
  );

  for (const entry of entries) {
    const actor = getActorFromDirectoryEntry(entry);
    if (!actor) continue;

    const context = getPrototypeLinkContext(actor);
    if (!context) continue;

    const existing = entry.querySelector(INDICATOR_SELECTOR);

    if (existing) {
      applyIndicatorState(existing, context);
      continue;
    }

    const indicator = document.createElement("span");
    indicator.classList.add(
      "argas-tli-indicator",
      "argas-tli-directory-indicator"
    );

    // Place the indicator inside the name element, directly after the name
    // text. The name element stretches across the row, so inserting after it
    // would push the indicator to the far right edge.
    const name = entry.querySelector(".entry-name");

    if (name) {
      prepareDirectoryEntryName(name);
      name.append(indicator);
    } else {
      entry.append(indicator);
    }

    prepareInteractiveIndicator(indicator);
    applyIndicatorState(indicator, context);
  }
}

// The name element becomes a flex row (see CSS) so that a long name shrinks
// with an ellipsis while the indicator stays visible. Bare text nodes cannot
// shrink inside a flex container, so wrap them in spans first.
function prepareDirectoryEntryName(name) {
  for (const node of [...name.childNodes]) {
    if (
      node.nodeType === Node.TEXT_NODE &&
      node.textContent.trim()
    ) {
      const wrapper = document.createElement("span");
      node.replaceWith(wrapper);
      wrapper.append(node);
    }
  }
}

function getActorFromDirectoryEntry(entry) {
  const uuid = entry.dataset.uuid;

  if (uuid) {
    const viaUuid = resolveUuidSync(uuid);
    if (isActorDocument(viaUuid)) return viaUuid;
  }

  const viaId =
  globalThis.game?.actors?.get?.(
    entry.dataset.entryId
  );

  return isActorDocument(viaId) ? viaId : null;
}

function prepareInteractiveIndicator(indicator) {
  if (!indicator) return;
  if (indicator.dataset.argasTliInteractive === "true") return;

  indicator.dataset.argasTliInteractive = "true";
  indicator.setAttribute("role", "button");
  indicator.setAttribute("tabindex", "0");

  // Prevent interaction in the sheet header from initiating a window drag,
  // and suppress the browser's middle-click autoscroll.
  indicator.addEventListener("pointerdown", (event) => {
    if (
      event.button === 0 ||
      event.button === 1 ||
      event.button === 2
    ) {
      event.stopPropagation();

      if (event.button === 1) {
        event.preventDefault();

        // Foundry locks the hovered tooltip on middle-click (pointerup,
        // capture phase on document.body, so it cannot be stopped from here).
        // A locked tooltip is a clone without the #tooltip id, which drops
        // this module's tooltip styling. Deactivating beforehand makes
        // Foundry's lock handler bail out.
        globalThis.game?.tooltip?.deactivate?.();
      }
    }
  });

  indicator.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    void toggleIndicatorLinkState(indicator);
  });

  indicator.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();

    void openIndicatorConfiguration(indicator);
  });

  // Middle-click reveals the associated Actor in the Actors sidebar. Sidebar
  // indicators are exempt: the entry is already in front of the user there.
  indicator.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;

    event.preventDefault();
    event.stopPropagation();

    if (isDirectoryIndicator(indicator)) return;

    void revealIndicatorActor(indicator);
  });

  indicator.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    event.stopPropagation();

    void toggleIndicatorLinkState(indicator);
  });
}

function applyIndicatorState(indicator, context) {
  if (!indicator || !context) return;

  prepareInteractiveIndicator(indicator);

  indicator.classList.toggle("is-linked", context.linked);
  indicator.classList.toggle("is-unlinked", !context.linked);
  indicator.classList.toggle(
    "is-prototype",
    context.kind === "prototype"
  );

  indicator.dataset.argasTliUuid = context.uuid ?? "";
  indicator.dataset.argasTliKind = context.kind;

  const iconClass = context.linked
  ? "fa-link"
  : "fa-link-slash";

  indicator.innerHTML = `
  <i class="fa-solid ${iconClass}" aria-hidden="true"></i>
  `;

  const actionLabel = localize(
    context.linked
    ? "ARGAS_TLI.Action.Unlink"
    : "ARGAS_TLI.Action.Link"
  );

  // Tooltips are rendered as HTML by Foundry, so the status may contain markup
  // such as <u>. Accessible names must stay plain text.
  indicator.setAttribute(
    "aria-label",
    `${toPlainText(context.status)} ${actionLabel}`
  );

  indicator.setAttribute(
    "aria-pressed",
    String(context.linked)
  );

  indicator.setAttribute(
    "data-tooltip",
    buildTooltip(indicator, context)
  );

  // Show the tooltip below the indicator instead of Foundry's default
  // placement above it.
  indicator.setAttribute(
    "data-tooltip-direction",
    "DOWN"
  );

  // Scope line-break rendering (\n in the localized strings) to our own
  // tooltips without affecting any other module's tooltip.
  indicator.setAttribute(
    "data-tooltip-class",
    "argas-tli-tooltip"
  );

  // Foundry renders data-tooltip. Keeping a native title as well causes two
  // tooltips to appear at the same time in some browsers.
  indicator.removeAttribute("title");
}

// One status line followed by one line per available mouse action. Sidebar
// indicators omit the middle-click line because the Actor is already listed
// there.
function buildTooltip(indicator, context) {
  const lines = [
    context.status,

    localize(
      context.linked
      ? "ARGAS_TLI.Hint.Unlink"
      : "ARGAS_TLI.Hint.Link"
    ),

    localize(
      context.kind === "token"
      ? "ARGAS_TLI.Hint.OpenToken"
      : "ARGAS_TLI.Hint.OpenPrototype"
    )
  ];

  if (!isDirectoryIndicator(indicator)) {
    lines.push(
      localize("ARGAS_TLI.Hint.Reveal")
    );
  }

  return lines.join("\n");
}

function toPlainText(text) {
  return String(text)
  .replace(/<[^>]*>/g, "")
  .replace(/\s+/g, " ")
  .trim();
}

function isDirectoryIndicator(indicator) {
  return Boolean(
    indicator?.classList?.contains(
      "argas-tli-directory-indicator"
    )
  );
}

async function toggleIndicatorLinkState(indicator) {
  if (!indicator) return;
  if (indicator.dataset.argasTliBusy === "true") return;

  const target = await resolveIndicatorTarget(indicator);
  if (!target) return;

  const {
    kind,
    document: targetDocument
  } = target;

  let currentLinked;
  let updateData;

  if (kind === "token") {
    currentLinked = Boolean(targetDocument.actorLink);

    updateData = {
      actorLink: !currentLinked
    };
  } else {
    currentLinked = Boolean(
      targetDocument.prototypeToken?.actorLink
    );

    updateData = {
      "prototypeToken.actorLink": !currentLinked
    };
  }

  if (!canUpdateDocument(targetDocument, updateData)) {
    notifyError("ARGAS_TLI.Error.NoPermission");
    return;
  }

  setIndicatorBusy(indicator, true);

  let updateError = null;

  try {
    await targetDocument.update(updateData);
  } catch (error) {
    updateError = error;
  }

  // The update promise can reject even though the database write succeeded:
  // Foundry v14's TokenDocument#_onRelatedUpdate pushes this token's delta
  // into every open TokenConfig preview and can throw there ("'set' on
  // proxy ... '_id'"). Judge success by the document's actual state instead
  // of trusting the promise.
  const linkedNow =
  kind === "token"
  ? Boolean(targetDocument.actorLink)
  : Boolean(
    targetDocument.prototypeToken?.actorLink
  );

  const applied = linkedNow === !currentLinked;

  if (applied) {
    if (updateError) {
      console.warn(
        `${MODULE_ID} | actorLink was toggled, but one of Foundry's own ` +
        "post-update handlers threw (known core issue when a token " +
        "configuration window is open).",
        updateError
      );
    }

    if (kind === "token") {
      await syncOpenTokenConfigurations(
        targetDocument,
        !currentLinked
      );

      // Toggling actorLink makes Foundry re-draw the token, which closes the
      // Token HUD. Re-open it so repeated toggling stays convenient.
      if (
        indicator.classList.contains(
          "argas-tli-hud-indicator"
        )
      ) {
        scheduleHudRestore(targetDocument);
      }
    }
  } else {
    console.error(
      `${MODULE_ID} | Failed to toggle actorLink`,
      updateError
    );

    notifyError("ARGAS_TLI.Error.UpdateFailed");
  }

  refreshVisibleIndicators();
  setIndicatorBusy(indicator, false);
}

function scheduleHudRestore(tokenDocument) {
  const restore = () => {
    const hud =
    globalThis.canvas?.tokens?.hud;

    // After the re-draw the document points at the freshly created token.
    const object = tokenDocument?.object;

    if (!hud || !object || object.destroyed) {
      return;
    }

    if (hud.object === object && hud.rendered) {
      return;
    }

    try {
      hud.bind(object);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Failed to keep the Token HUD open`,
        error
      );
    }
  };

  // The re-draw finishes shortly after the update resolves; try twice.
  requestAnimationFrame(restore);
  globalThis.setTimeout(restore, 200);
}

async function syncOpenTokenConfigurations(tokenDocument, linked) {
  const instances =
  globalThis.foundry?.applications?.instances;

  if (!instances?.values) return;

  for (const candidate of instances.values()) {
    if (candidate?.document !== tokenDocument) continue;

    try {
      candidate._previewChanges?.({
        actorLink: linked
      });

      if (candidate.rendered) {
        await candidate.render();
      }
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Failed to sync open token configuration`,
        error
      );
    }

    const input =
    candidate.element?.querySelector?.(
      'input[name="actorLink"], input[name$=".actorLink"]'
    );

    if (input) input.checked = linked;
  }
}

// Close sheets that are still bound to the former synthetic actor of a token
// that just became linked, and reopen the base Actor's sheet in their place.
// Closing must skip the save, otherwise the doomed submit would crash right
// there (AppV1 honours {submit: false}; AppV2 sheets never save on close).
async function migrateStaleSyntheticSheets(tokenDocument) {
  if (!tokenDocument?.actorLink) return;

  const candidates = [];

  const instances =
  globalThis.foundry?.applications?.instances;

  if (instances?.values) {
    candidates.push(...instances.values());
  }

  const legacyWindows = globalThis.ui?.windows;

  if (legacyWindows) {
    candidates.push(
      ...Object.values(legacyWindows)
    );
  }

  let position = null;
  let closedAny = false;

  for (const application of candidates) {
    // Token and prototype configuration windows manage themselves.
    if (
      typeof application?.isPrototype === "boolean"
    ) {
      continue;
    }

    const actor =
    getActorFromApplication(application);

    if (!actor?.isToken) continue;

    if (
      actor.token?.uuid !== tokenDocument.uuid
    ) {
      continue;
    }

    if (
      !position &&
      typeof application.position?.left === "number" &&
      typeof application.position?.top === "number"
    ) {
      position = {
        left: application.position.left,
        top: application.position.top
      };
    }

    try {
      await application.close({ submit: false });
      closedAny = true;
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Failed to close a stale token-actor sheet`,
        error
      );
    }
  }

  if (!closedAny) return;

  const baseActor =
  tokenDocument.baseActor ??
  globalThis.game?.actors?.get?.(
    tokenDocument.actorId
  );

  const sheet = baseActor?.sheet;
  if (!sheet?.render) return;

  // From the user's point of view the reopened sheet still belongs to this
  // scene token; keep the header indicator bound to it.
  SHEET_CONTEXTS.set(sheet, {
    kind: "token",
    uuid: tokenDocument.uuid
  });

  try {
    await sheet.render(true);

    if (position) {
      sheet.setPosition?.(position);
    }

    sheet.bringToFront?.();
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Failed to reopen the Actor sheet after linking`,
      error
    );
  }
}

async function openIndicatorConfiguration(indicator) {
  if (!indicator) return;
  if (indicator.dataset.argasTliBusy === "true") return;

  const target = await resolveIndicatorTarget(indicator);
  if (!target) return;

  setIndicatorBusy(indicator, true);

  try {
    if (target.kind === "token") {
      notifyTargetContext(
        "ARGAS_TLI.Notice.EditingToken"
      );

      await renderTokenConfiguration(
        target.document
      );
    } else {
      notifyTargetContext(
        "ARGAS_TLI.Notice.EditingPrototype"
      );

      await renderPrototypeConfiguration(
        target.document
      );
    }
  } catch (error) {
    console.error(
      `${MODULE_ID} | Failed to open token configuration`,
      error
    );

    notifyError(
      "ARGAS_TLI.Error.ConfigOpenFailed"
    );
  } finally {
    setIndicatorBusy(indicator, false);
  }
}

async function revealIndicatorActor(indicator) {
  if (!indicator) return;

  const target = await resolveIndicatorTarget(indicator);
  if (!target) return;

  // Unlinked scene tokens have no sidebar entry of their own; reveal the
  // world Actor they were created from instead.
  const actor =
  target.kind === "token"
  ? target.document.baseActor ??
  globalThis.game?.actors?.get?.(
    target.document.actorId
  )
  : target.document;

  const worldActor =
  actor &&
  globalThis.game?.actors?.get?.(actor.id);

  if (!worldActor) {
    notifyError(
      "ARGAS_TLI.Error.ActorNotInSidebar"
    );

    return;
  }

  await revealActorInSidebar(worldActor);
}

async function revealActorInSidebar(actor) {
  const sidebar = globalThis.ui?.sidebar;

  try {
    sidebar?.expand?.();
  } catch (_error) {
    // Ignore: revealing continues even if expanding fails.
  }

  try {
    if (typeof sidebar?.changeTab === "function") {
      sidebar.changeTab("actors", "primary");
    } else {
      sidebar?.activateTab?.("actors");
    }
  } catch (_error) {
    // Ignore: the tab may already be active.
  }

  const directory = globalThis.ui?.actors;
  if (!directory) return;

  // Expand collapsed ancestor folders, otherwise the entry stays hidden.
  const expandedState =
  globalThis.game?.folders?._expanded;

  let folder = actor.folder;
  let expandedAny = false;

  while (folder) {
    if (expandedState && !folder.expanded) {
      expandedState[folder.uuid] = true;
      expandedState[folder.id] = true;
      expandedAny = true;
    }

    folder = folder.folder;
  }

  if (expandedAny) {
    try {
      await directory.render();
    } catch (_error) {
      // Ignore: highlighting below still works for visible entries.
    }
  }

  // Wait one frame so the tab switch and re-render have settled.
  requestAnimationFrame(() => {
    const root = toHTMLElement(directory.element);

    const entry = root?.querySelector?.(
      `li[data-entry-id="${actor.id}"]`
    );

    if (!entry) return;

    flashDirectoryEntryAfterScroll(entry);
  });
}

// Scroll the entry into view and start the flash only once the smooth
// scroll has settled, so no pulses play outside the visible area.
function flashDirectoryEntryAfterScroll(entry) {
  let begun = false;
  let sawScroll = false;
  let fallbackTimer = 0;

  // Ignore scrolling that happens elsewhere (chat log, journals, ...).
  const concernsEntry = (event) =>
  event.target === globalThis.document ||
  (event.target instanceof HTMLElement &&
    event.target.contains(entry));

  const begin = () => {
    if (begun) return;
    begun = true;

    globalThis.clearTimeout(fallbackTimer);

    globalThis.removeEventListener(
      "scroll", onScroll, true
    );

    globalThis.removeEventListener(
      "scrollend", onScrollEnd, true
    );

    flashDirectoryEntry(entry);
  };

  const onScroll = (event) => {
    if (begun || sawScroll) return;
    if (!concernsEntry(event)) return;
    sawScroll = true;

    // Scrolling is under way: replace the short fallback with a generous
    // one in case the browser never fires "scrollend".
    globalThis.clearTimeout(fallbackTimer);
    fallbackTimer = globalThis.setTimeout(begin, 1500);
  };

  const onScrollEnd = (event) => {
    if (concernsEntry(event)) begin();
  };

  globalThis.addEventListener(
    "scroll", onScroll, true
  );

  globalThis.addEventListener(
    "scrollend", onScrollEnd, true
  );

  // If the entry is already in view no scroll event ever arrives;
  // start after a barely noticeable delay instead.
  fallbackTimer = globalThis.setTimeout(begin, 150);

  entry.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

function flashDirectoryEntry(entry) {
  // Cancel the cleanup timer of a previous reveal, otherwise it would
  // strip the class mid-animation and cut the new flash short.
  const pendingTimer = Number(
    entry.dataset.argasTliFlashTimer || 0
  );

  if (pendingTimer) {
    globalThis.clearTimeout(pendingTimer);
  }

  // Restart the flash animation even when the entry was just highlighted.
  entry.classList.remove(
    "argas-tli-directory-flash"
  );

  void entry.offsetWidth;

  entry.classList.add(
    "argas-tli-directory-flash"
  );

  const cleanupTimer = globalThis.setTimeout(() => {
    entry.classList.remove(
      "argas-tli-directory-flash"
    );

    delete entry.dataset.argasTliFlashTimer;
  }, 3500);

  entry.dataset.argasTliFlashTimer = String(cleanupTimer);
}

async function resolveIndicatorTarget(indicator) {
  const uuid =
  indicator?.dataset?.argasTliUuid;

  const kind =
  indicator?.dataset?.argasTliKind;

  if (!uuid || !kind) return null;

  const targetDocument =
  await resolveUuid(uuid);

  if (!targetDocument) {
    notifyError(
      "ARGAS_TLI.Error.DocumentNotFound"
    );

    return null;
  }

  if (
    kind === "token" &&
    isTokenDocument(targetDocument)
  ) {
    return {
      kind,
      document: targetDocument
    };
  }

  if (
    kind === "prototype" &&
    isActorDocument(targetDocument)
  ) {
    return {
      kind,
      document: targetDocument
    };
  }

  notifyError(
    "ARGAS_TLI.Error.DocumentNotFound"
  );

  return null;
}

async function renderTokenConfiguration(token) {
  const sheet = token?.sheet;

  if (!sheet?.render) {
    throw new Error(
      "Token configuration sheet is unavailable."
    );
  }

  await sheet.render(true);
}

async function renderPrototypeConfiguration(actor) {
  const SheetClass =
  globalThis.CONFIG?.Token?.prototypeSheetClass ??
  globalThis.foundry?.applications?.sheets?.PrototypeTokenConfig;

  const prototypeToken = actor?.prototypeToken;

  if (!SheetClass) {
    throw new Error(
      "PrototypeTokenConfig is unavailable."
    );
  }

  if (!prototypeToken) {
    throw new Error(
      "Actor prototype token is unavailable."
    );
  }

  const instances =
  globalThis.foundry?.applications?.instances;

  if (instances?.values) {
    for (const candidate of instances.values()) {
      if (
        candidate instanceof SheetClass &&
        candidate.actor === actor
      ) {
        await candidate.render({ force: true });
        candidate.bringToFront?.();
        return;
      }
    }
  }

  const application = new SheetClass({
    prototype: prototypeToken
  });

  if (!application?.render) {
    throw new Error(
      "Prototype token configuration sheet is unavailable."
    );
  }

  await application.render({
    force: true
  });
}

function canUpdateDocument(document, updateData) {
  try {
    return (
      document.canUserModify?.(
        game.user,
        "update",
        updateData
      ) ??
      document.isOwner ??
      false
    );
  } catch (_error) {
    return document.isOwner ?? false;
  }
}

function setIndicatorBusy(indicator, busy) {
  indicator.dataset.argasTliBusy =
  String(busy);

  indicator.classList.toggle(
    "is-updating",
    busy
  );

  indicator.setAttribute(
    "aria-busy",
    String(busy)
  );
}

function getSheetLinkContext(application, actor) {
  // Token and prototype configuration windows state which of the two they
  // edit (isPrototype). That declaration is authoritative: a token selected
  // on the canvas must never redirect a Prototype Token Configuration to the
  // scene token, and vice versa.
  if (typeof application?.isPrototype === "boolean") {
    if (application.isPrototype) {
      return getPrototypeLinkContext(actor);
    }

    // Token configuration windows expose a preview clone via application.token,
    // and Foundry deliberately strips actorLink from preview updates
    // (TokenConfig#_previewChanges). Read the real document instead, otherwise
    // the indicator keeps showing the pre-toggle state after re-renders.
    const configuredToken =
    asTokenDocument(application.document) ??
    getTokenFromApplication(application, actor);

    return configuredToken
    ? getTokenLinkContext(configuredToken)
    : getPrototypeLinkContext(actor);
  }

  const cached =
  SHEET_CONTEXTS.get(application);

  if (cached?.kind === "token") {
    const cachedToken =
    resolveUuidSync(cached.uuid);

    if (isTokenDocument(cachedToken)) {
      return getTokenLinkContext(
        cachedToken
      );
    }
  }

  // Unlinked/synthetic Actor sheets normally expose actor.token directly.
  // Linked token sheets can lose that reference, so also inspect the currently
  // controlled canvas token. This keeps a sheet opened from the canvas tied to
  // that concrete token instead of silently falling back to the prototype.
  const token =
  getTokenFromApplication(
    application,
    actor
  ) ??
  getControlledTokenForActor(actor);

  if (token) {
    return getTokenLinkContext(token);
  }

  return getPrototypeLinkContext(actor);
}

function getPrototypeLinkContext(actor) {
  const prototypeToken =
  actor?.prototypeToken;

  if (
    !prototypeToken ||
    typeof prototypeToken.actorLink !== "boolean"
  ) {
    return null;
  }

  return {
    linked: Boolean(
      prototypeToken.actorLink
    ),

    kind: "prototype",
    uuid: actor.uuid,

    status: localize(
      prototypeToken.actorLink
      ? "ARGAS_TLI.Status.PrototypeLinked"
      : "ARGAS_TLI.Status.PrototypeUnlinked"
    )
  };
}

function getTokenLinkContext(token) {
  const linked =
  Boolean(token.actorLink);

  return {
    linked,
    kind: "token",
    uuid: token.uuid,

    status: localize(
      linked
      ? "ARGAS_TLI.Status.TokenLinked"
      : "ARGAS_TLI.Status.TokenUnlinked"
    )
  };
}

function getActorFromApplication(application) {
  const candidates = [
    application?.actor,
    application?.document,
    application?.object
  ];

  return (
    candidates.find(isActorDocument) ??
    null
  );
}

function getTokenFromApplication(
  application,
  actor
) {
  const candidates = [
    application?.token,
    application?.options?.token,
    application?.options?.document?.token,
    actor?.token
  ];

  for (const candidate of candidates) {
    const token =
    asTokenDocument(candidate);

    if (token) return token;
  }

  return null;
}

function getControlledTokenForActor(actor) {
  const controlled =
  globalThis.canvas?.tokens?.controlled ??
  [];

  const matches = controlled
  .map(asTokenDocument)
  .filter(
    (token) =>
    token &&
    tokenRepresentsActor(token, actor)
  );

  return matches.length === 1
  ? matches[0]
  : null;
}

function tokenRepresentsActor(token, actor) {
  if (!token || !actor) return false;

  // Only a token whose current Actor IS this sheet's Actor may claim the
  // sheet - that is true for linked tokens. An unlinked token merely descends
  // from the base Actor: it presents its own delta-backed token actor (with
  // its own sheet), so the base Actor's sheet must not bind to it and falls
  // back to the prototype instead.
  if (token.actor === actor) {
    return true;
  }

  return Boolean(
    token.actor?.uuid &&
    token.actor.uuid === actor.uuid
  );
}

function getTokenFromHud(application, data) {
  const candidates = [
    application?.object,
    application?.document,
    application?.token,
    data?.token,
    globalThis.canvas?.tokens?.get?.(
      data?._id
    ),
    globalThis.canvas?.tokens?.get?.(
      data?.id
    )
  ];

  for (const candidate of candidates) {
    const token =
    asTokenDocument(candidate);

    if (token) return token;
  }

  return null;
}

function asTokenDocument(candidate) {
  if (!candidate) return null;

  if (isTokenDocument(candidate)) {
    return candidate;
  }

  if (isTokenDocument(candidate.document)) {
    return candidate.document;
  }

  return null;
}

function isActorDocument(candidate) {
  return (
    candidate?.documentName === "Actor" ||
    candidate?.constructor?.documentName ===
    "Actor"
  );
}

function isTokenDocument(candidate) {
  return (
    candidate?.documentName === "Token" ||
    candidate?.constructor?.documentName ===
    "Token"
  );
}

function getApplicationWindow(
  application,
  renderedElement
) {
  const appElement =
  toHTMLElement(application?.element);

  const candidates = [
    renderedElement,
    appElement
  ].filter(Boolean);

  for (const element of candidates) {
    if (element.matches?.(".application")) {
      return element;
    }

    const windowElement =
    element.closest?.(".application");

    if (windowElement) {
      return windowElement;
    }

    if (
      element.querySelector?.(".window-header")
    ) {
      return element;
    }
  }

  return null;
}

function toHTMLElement(value) {
  if (!value) return null;

  if (value instanceof HTMLElement) {
    return value;
  }

  if (value?.[0] instanceof HTMLElement) {
    return value[0];
  }

  return null;
}

function refreshVisibleIndicators() {
  for (
    const indicator of document.querySelectorAll(
      INDICATOR_SELECTOR
    )
  ) {
    const uuid =
    indicator.dataset.argasTliUuid;

    const kind =
    indicator.dataset.argasTliKind;

    if (!uuid || !kind) continue;

    const targetDocument =
    resolveUuidSync(uuid);

    if (!targetDocument) continue;

    if (
      kind === "token" &&
      isTokenDocument(targetDocument)
    ) {
      applyIndicatorState(
        indicator,
        getTokenLinkContext(targetDocument)
      );

      continue;
    }

    if (
      kind === "prototype" &&
      isActorDocument(targetDocument)
    ) {
      applyIndicatorState(
        indicator,
        getPrototypeLinkContext(
          targetDocument
        )
      );
    }
  }
}

function resolveUuidSync(uuid) {
  try {
    return (
      globalThis.fromUuidSync?.(uuid) ??
      null
    );
  } catch (_error) {
    return null;
  }
}

async function resolveUuid(uuid) {
  const synchronous =
  resolveUuidSync(uuid);

  if (synchronous) {
    return synchronous;
  }

  try {
    return (
      await globalThis.fromUuid?.(uuid) ??
      null
    );
  } catch (_error) {
    return null;
  }
}

function notifyTargetContext(key) {
  const message = localize(key);

  const notifications =
  globalThis.ui?.notifications;

  // The success variant is green, setting this context notice apart from
  // plain info messages; info is the fallback where success is unavailable.
  const notification =
  notifications?.success
  ? notifications.success(
    message,
    {
      console: false
    }
  )
  : notifications?.info?.(
    message,
    {
      console: false
    }
  );

  markContextNotification(
    notification,
    notifications
  );
}

function markContextNotification(
  notification,
  notifications
) {
  if (!notification || !notifications) {
    return;
  }

  const startedAt = Date.now();

  const timer =
  globalThis.setInterval(() => {
    const element =
    notification.element;

    if (element instanceof HTMLElement) {
      element.classList.add(
        "argas-tli-context-notification"
      );

      globalThis.clearInterval(timer);
      return;
    }

    // Stop polling once Foundry has removed the notification or after a safe
    // timeout. This also handles notifications which briefly wait in a queue.
    const expired =
    Date.now() - startedAt > 10000;

    const removed =
    notifications.has?.(
      notification
    ) === false;

    if (expired || removed) {
      globalThis.clearInterval(timer);
    }
  }, 50);
}

function notifyError(key) {
  const message = localize(key);

  globalThis.ui?.notifications?.error?.(
    message
  );
}

function localize(key) {
  try {
    return game.i18n.localize(key);
  } catch (_error) {
    return key;
  }
}
