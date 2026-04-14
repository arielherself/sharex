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

  async function openScreenshot(button) {
    const target = document.querySelector(button.dataset.screenshotTarget);
    if (!target) {
      return;
    }

    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Rendering...";

    try {
      const dataUrl = await renderElementImage(target);
      ensureOverlay();
      overlayImage.src = dataUrl;
      overlayImage.alt = "Post image card";
      overlay.hidden = false;
      document.body.classList.add("photo-overlay-open");
      closeButton.focus();
    } catch {
      button.textContent = "Could not render";
      setTimeout(() => {
        button.textContent = previousLabel;
      }, 1600);
      return;
    } finally {
      button.disabled = false;
      if (button.textContent === "Rendering...") {
        button.textContent = previousLabel;
      }
    }
  }

  async function renderElementImage(target) {
    const rect = target.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const clone = target.cloneNode(true);
    await prepareScreenshotClone(clone);
    const styles = collectStyles();
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml">
            <style>${escapeStyleText(styles)}</style>
            ${xhtml}
          </div>
        </foreignObject>
      </svg>`;
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = await loadImage(svgUrl);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  }

  async function prepareScreenshotClone(clone) {
    clone.querySelectorAll("video").forEach((video) => {
      const poster = video.getAttribute("poster");
      const image = document.createElement("img");
      image.className = video.className || "post-video";
      image.alt = "Video preview";
      if (poster) {
        image.src = new URL(poster, window.location.href).href;
      }
      video.replaceWith(image);
    });

    clone.querySelectorAll("img").forEach((image) => {
      const src = image.getAttribute("src");
      if (src) {
        image.src = new URL(src, window.location.href).href;
      }
    });

    clone.querySelectorAll(".video-download").forEach((element) => element.remove());
    await inlineCloneImages(clone);
    await decodeCloneImages(clone);
  }

  async function inlineCloneImages(clone) {
    await Promise.all(
      [...clone.querySelectorAll("img")].map(async (image) => {
        if (!image.src || image.src.startsWith("data:")) {
          return;
        }

        try {
          const response = await fetch(image.src);
          if (!response.ok) {
            return;
          }
          image.src = await blobToDataUrl(await response.blob());
        } catch {
          // Leave the absolute URL in place; the rest of the card can still render.
        }
      })
    );
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function decodeCloneImages(clone) {
    await Promise.all(
      [...clone.querySelectorAll("img")].map((image) => {
        if (!image.src) {
          return Promise.resolve();
        }
        if (typeof image.decode === "function") {
          return image.decode().catch(() => {});
        }
        return new Promise((resolve) => {
          image.onload = () => resolve();
          image.onerror = () => resolve();
        });
      })
    );
  }

  function collectStyles() {
    return [...document.styleSheets]
      .map((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        } catch {
          return "";
        }
      })
      .join("\n");
  }

  function escapeStyleText(value) {
    return String(value).replaceAll("</style", "<\\/style");
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
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
    if (link) {
      event.preventDefault();
      openOverlay(link);
      return;
    }

    const screenshotButton = event.target.closest(".screenshot-button");
    if (screenshotButton) {
      openScreenshot(screenshotButton);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOverlay();
    }
  });
})();
