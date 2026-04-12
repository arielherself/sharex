(() => {
  let overlay;
  let overlayImage;
  let closeButton;

  function ensureOverlay() {
    if (overlay) {
      return;
    }

    overlay = document.createElement("div");
    overlay.className = "photo-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Photo preview");

    closeButton = document.createElement("button");
    closeButton.className = "photo-overlay-close";
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", closeOverlay);

    overlayImage = document.createElement("img");
    overlayImage.className = "photo-overlay-image";
    overlayImage.decoding = "async";

    overlay.append(closeButton, overlayImage);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeOverlay();
      }
    });

    document.body.append(overlay);
  }

  function openOverlay(link) {
    ensureOverlay();
    const thumbnail = link.querySelector("img");
    overlayImage.src = link.href;
    overlayImage.alt = thumbnail?.alt || "Post photo";
    overlay.hidden = false;
    document.body.classList.add("photo-overlay-open");
    closeButton.focus();
  }

  function closeOverlay() {
    if (!overlay || overlay.hidden) {
      return;
    }

    overlay.hidden = true;
    overlayImage.removeAttribute("src");
    document.body.classList.remove("photo-overlay-open");
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a.photo-link");
    if (!link) {
      return;
    }

    event.preventDefault();
    openOverlay(link);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOverlay();
    }
  });
})();
