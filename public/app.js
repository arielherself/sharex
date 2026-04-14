(() => {
  const IMAGE_FETCH_TIMEOUT_MS = 15000;
  const IMAGE_DECODE_TIMEOUT_MS = 5000;
  const CARD_IMAGE_TIMEOUT_MS = 10000;
  const THEME_LIGHT = "light";
  const THEME_DARK = "dark";


  let overlay;
  let overlayImage;
  let closeButton;
  let shareButton;
  let themeButton;
  let currentScreenshotFile;
  let screenshotTheme = THEME_LIGHT;
  let screenshotTarget = null;
  let screenshotSourceButton = null;

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

    themeButton = document.createElement("button");
    themeButton.className = "screenshot-theme-toggle";
    themeButton.type = "button";
    themeButton.hidden = true;
    themeButton.addEventListener("click", toggleScreenshotTheme);

    shareButton = document.createElement("button");
    shareButton.className = "screenshot-share";
    shareButton.type = "button";
    shareButton.textContent = "Share";
    shareButton.hidden = true;
    shareButton.addEventListener("click", shareScreenshot);

    overlayImage = document.createElement("img");
    overlayImage.className = "photo-overlay-image";
    overlayImage.decoding = "async";

    overlay.append(closeButton, overlayImage, themeButton, shareButton);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeOverlay();
      }
    });

    document.body.append(overlay);
  }

  function openOverlay(link) {
    ensureOverlay();
    clearScreenshotShare();
    clearScreenshotThemeControl();
    screenshotTarget = null;
    screenshotSourceButton = null;
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

    screenshotTarget = target;
    screenshotSourceButton = button;
    screenshotTheme = resolveSystemTheme();
    await renderScreenshotPreview();
  }

  async function renderScreenshotPreview(theme = screenshotTheme) {
    if (!screenshotTarget || !screenshotSourceButton) {
      return;
    }

    screenshotTheme = isTheme(theme) ? theme : THEME_LIGHT;
    ensureOverlay();
    setScreenshotThemeControl(screenshotTheme);

    const button = screenshotSourceButton;
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Rendering...";
    if (themeButton) {
      themeButton.disabled = true;
    }
    if (shareButton && !shareButton.hidden) {
      shareButton.disabled = true;
    }

    try {
      const screenshot = await renderElementImage(
        screenshotTarget,
        screenshotFilename(button, screenshotTarget),
        screenshotTheme
      );
      overlayImage.src = screenshot.dataUrl;
      overlayImage.alt = `Post image card (${screenshotTheme} theme)`;
      setScreenshotShare(screenshot.file);
      overlay.hidden = false;
      document.body.classList.add("photo-overlay-open");
      (shareButton.hidden || shareButton.disabled ? closeButton : shareButton).focus();
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
      if (themeButton) {
        themeButton.disabled = false;
      }
    }
  }

  async function renderElementImage(target, filename, theme = THEME_LIGHT) {
    const rect = target.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    const clone = target.cloneNode(true);
    clone.dataset.theme = isTheme(theme) ? theme : THEME_LIGHT;
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
    await waitForFrames(2);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    const blob = dataUrlToBlob(dataUrl);
    return {
      dataUrl,
      file: makeFile(blob, filename),
    };
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
      image.loading = "eager";
      image.decoding = "sync";
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
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
          const response = await fetchWithTimeout(image.src, IMAGE_FETCH_TIMEOUT_MS);
          if (!response || !response.ok) {
            return;
          }
          image.src = await blobToDataUrl(await response.blob());
        } catch {
          // Leave the absolute URL in place; the rest of the card can still render.
        }
      })
    );
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        if (controller) {
          controller.abort();
        }
        resolve(null);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        fetch(url, controller ? { signal: controller.signal } : undefined),
        timeout,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [header, payload] = dataUrl.split(",");
    const mime = header.match(/^data:([^;]+)/)?.[1] || "application/octet-stream";
    const binary = atob(payload || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime });
  }

  function makeFile(blob, filename) {
    try {
      return new File([blob], filename, { type: blob.type || "image/png" });
    } catch {
      blob.name = filename;
      return blob;
    }
  }

  function screenshotFilename(button, target) {
    const filename = button.dataset.screenshotFilename || target.dataset.postId || "post.png";
    const basename = filename
      .replace(/\.png$/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "") || "post";
    return `${basename}.png`;
  }

  function setScreenshotThemeControl(theme) {
    if (!themeButton) {
      return;
    }

    const isDark = theme === THEME_DARK;
    themeButton.hidden = false;
    themeButton.textContent = `Screenshot: ${isDark ? "Dark" : "Light"}`;
    themeButton.setAttribute("aria-pressed", String(isDark));
  }

  function clearScreenshotThemeControl() {
    if (!themeButton) {
      return;
    }

    themeButton.hidden = true;
    themeButton.disabled = false;
    themeButton.textContent = "Screenshot: Light";
    themeButton.setAttribute("aria-pressed", "false");
  }

  async function toggleScreenshotTheme() {
    await renderScreenshotPreview(screenshotTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK);
  }

  function setScreenshotShare(file) {
    currentScreenshotFile = file;
    shareButton.textContent = "Share";
    shareButton.hidden = false;
    shareButton.disabled = !canShareScreenshot(file);
    shareButton.title = shareButton.disabled ? "Image sharing is not supported in this browser." : "";
  }

  function clearScreenshotShare() {
    currentScreenshotFile = null;
    if (!shareButton) {
      return;
    }
    shareButton.hidden = true;
    shareButton.disabled = false;
    shareButton.textContent = "Share";
    shareButton.removeAttribute("title");
  }

  function canShareScreenshot(file) {
    if (!navigator.share || !file) {
      return false;
    }
    if (navigator.canShare) {
      return navigator.canShare({ files: [file] });
    }
    return true;
  }

  async function shareScreenshot() {
    if (!currentScreenshotFile || !canShareScreenshot(currentScreenshotFile)) {
      return;
    }

    const previousLabel = shareButton.textContent;
    shareButton.disabled = true;
    shareButton.textContent = "Sharing...";

    try {
      await navigator.share({
        files: [currentScreenshotFile],
        title: document.title || "Post screenshot",
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        shareButton.textContent = "Could not share";
        setTimeout(() => {
          shareButton.textContent = previousLabel;
          shareButton.disabled = !canShareScreenshot(currentScreenshotFile);
        }, 1600);
        return;
      }
    }

    shareButton.textContent = previousLabel;
    shareButton.disabled = !canShareScreenshot(currentScreenshotFile);
  }

  async function decodeCloneImages(clone) {
    await Promise.all(
      [...clone.querySelectorAll("img")].map((image) => {
        if (!image.src) {
          return Promise.resolve();
        }
        return preloadImage(image.src, IMAGE_DECODE_TIMEOUT_MS);
      })
    );
  }

  function preloadImage(src, timeoutMs) {
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "sync";
      const timeoutId = setTimeout(finish, timeoutMs);
      function finish() {
        clearTimeout(timeoutId);
        image.onload = null;
        image.onerror = null;
        resolve();
      }
      image.onload = () => {
        if (typeof image.decode === "function") {
          Promise.race([image.decode().catch(() => {}), wait(timeoutMs)]).then(finish);
          return;
        }
        finish();
      };
      image.onerror = finish;
      image.src = src;
      if (image.complete) {
        finish();
      }
    });
  }

  async function waitForFrames(count) {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
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
      const timeoutId = setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        reject(new Error("Timed out while rendering screenshot."));
      }, CARD_IMAGE_TIMEOUT_MS);
      image.onload = () => {
        clearTimeout(timeoutId);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeoutId);
        reject(new Error("Could not render screenshot."));
      };
      image.src = src;
    });
  }

  function closeOverlay() {
    if (!overlay || overlay.hidden) {
      return;
    }

    overlay.hidden = true;
    overlayImage.removeAttribute("src");
    clearScreenshotShare();
    clearScreenshotThemeControl();
    screenshotTarget = null;
    screenshotSourceButton = null;
    document.body.classList.remove("photo-overlay-open");
  }

  function resolveSystemTheme() {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? THEME_DARK : THEME_LIGHT;
    }
    return THEME_LIGHT;
  }

  function isTheme(value) {
    return value === THEME_LIGHT || value === THEME_DARK;
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
